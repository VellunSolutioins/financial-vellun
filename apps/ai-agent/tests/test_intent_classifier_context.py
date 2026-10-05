"""Testes de contexto/histórico no IntentClassifier (Etapa 3)."""

import asyncio

import pytest

from src.schemas.financial_intent import (
    AccountKindEnum,
    AmountBasisEnum,
    FinancialIntent,
    IntentType,
    RecurrenceFrequencyEnum,
    RecurrenceTypeEnum,
    TransactionTypeEnum,
)
from src.services.intent_classifier import IntentClassifier


def test_rules_ignore_history_without_breaking():
    classifier = IntentClassifier(provider=None)
    context = {"recent_messages": [{"direction": "inbound", "content": "oi"}]}
    result = asyncio.run(classifier.classify("gastei 50 no mercado", context))
    assert result.intent == IntentType.create_transaction
    assert result.amount == 50


def test_provider_receives_recent_messages():
    captured = {}

    class FakeProvider:
        async def extract_intent(self, message, context):
            captured["context"] = context
            return FinancialIntent(intent=IntentType.help, confidence=0.9)

    classifier = IntentClassifier(provider=FakeProvider())
    history = [{"direction": "inbound", "content": "paguei 300"}]
    asyncio.run(classifier.classify("internet", {"recent_messages": history}))

    assert captured["context"]["recent_messages"] == history


# ── Conferência da extração do LLM com as regras ─────────────────────────────


def classify_with_llm(message: str, **llm_fields) -> FinancialIntent:
    """Classifica ``message`` com um LLM que devolve exatamente ``llm_fields``."""

    class FakeProvider:
        async def extract_intent(self, message, context):
            return FinancialIntent(
                intent=IntentType.create_transaction,
                transaction_type=TransactionTypeEnum.expense,
                category_name="Mercado",
                confidence=0.9,
                **llm_fields,
            )

    return asyncio.run(IntentClassifier(provider=FakeProvider()).classify(message, {}))


def test_valor_seguido_de_em_nx_e_total_mesmo_com_llm_dizendo_parcela():
    # Caso de produção: gravou 2x de 36,65 (total 73,30).
    result = classify_with_llm(
        "Adicionar gasto de 36,65 em 2x no cartão inter",
        amount=36.65,
        recurrence_type=RecurrenceTypeEnum.parcelado,
        installments=2,
        amount_basis=AmountBasisEnum.installment,
    )
    assert result.amount == 36.65
    assert result.installments == 2
    assert result.amount_basis == AmountBasisEnum.total


def test_nx_de_valor_e_parcela_mesmo_com_llm_dizendo_total():
    result = classify_with_llm(
        "tv em 10x de 300",
        amount=300,
        recurrence_type=RecurrenceTypeEnum.parcelado,
        installments=10,
        amount_basis=AmountBasisEnum.total,
    )
    assert result.amount_basis == AmountBasisEnum.installment


def test_parcelas_explicitas_corrigem_o_llm():
    result = classify_with_llm("comprei tênis 300 em 3x", amount=300)
    assert result.recurrence_type == RecurrenceTypeEnum.parcelado
    assert result.installments == 3
    assert result.amount_basis == AmountBasisEnum.total

    trocado = classify_with_llm(
        "comprei tênis 300 em 3x",
        amount=300,
        recurrence_type=RecurrenceTypeEnum.fixo,
        recurrence_frequency=RecurrenceFrequencyEnum.monthly,
        occurrences=3,
    )
    assert trocado.recurrence_type == RecurrenceTypeEnum.parcelado
    assert (trocado.recurrence_frequency, trocado.occurrences) == (None, None)


@pytest.mark.parametrize("llm_amount", [18.33, 73.3])
def test_llm_que_fez_a_conta_volta_ao_valor_digitado(llm_amount):
    result = classify_with_llm(
        "gasto de 36,65 em 2x",
        amount=llm_amount,
        recurrence_type=RecurrenceTypeEnum.parcelado,
        installments=2,
        amount_basis=AmountBasisEnum.total,
    )
    assert result.amount == 36.65


def test_frase_ambigua_deixa_a_base_para_perguntar():
    result = classify_with_llm(
        "3000 em 10x de 300",
        amount=3000,
        recurrence_type=RecurrenceTypeEnum.parcelado,
        installments=10,
        amount_basis=AmountBasisEnum.total,
    )
    assert result.amount_basis is None


def test_sem_sinal_nas_regras_fica_o_llm():
    result = classify_with_llm(
        "parcelei a geladeira, 300 por mês em dez vezes",
        amount=300,
        recurrence_type=RecurrenceTypeEnum.parcelado,
        installments=10,
        amount_basis=AmountBasisEnum.installment,
    )
    assert result.amount_basis == AmountBasisEnum.installment
    assert result.installments == 10


def test_avulso_sem_parcelas_nao_muda():
    result = classify_with_llm("gastei 50 no mercado", amount=50)
    assert result.recurrence_type == RecurrenceTypeEnum.avulso
    assert result.category_name == "Mercado"


def test_outros_como_curinga_vira_pergunta():
    class FakeProvider:
        async def extract_intent(self, message, context):
            return FinancialIntent(
                intent=IntentType.create_transaction,
                transaction_type=TransactionTypeEnum.expense,
                amount=266.4,
                category_name="Outros",
                confidence=0.9,
            )

    classifier = IntentClassifier(provider=FakeProvider())
    curinga = asyncio.run(classifier.classify("gasto 266,40 com roupas", {}))
    assert curinga.category_name is None
    assert curinga.needs_confirmation is True

    pedido = asyncio.run(classifier.classify("gasto 266,40 em outros", {}))
    assert pedido.category_name == "Outros"


# ── Conta e cartão só valem se a mensagem disser (docs/adrs/0020) ────────────
# Em produção o LLM devolvia "account" para mensagens sem menção, e o cartão
# marcado como padrão era ignorado.


@pytest.mark.parametrize(
    "message",
    [
        "Compra de capa do celular no valor de 38,60",
        "Compra de 18,95 nas loterias da caixa",
        "gastei 50 no mercado",
        "paguei 180 da conta de luz",
    ],
)
def test_conta_que_o_llm_inventou_e_descartada(message):
    result = classify_with_llm(
        message, amount=50, account_kind=AccountKindEnum.account, account_name="Conta Principal"
    )
    assert result.account_kind is None
    assert result.account_name is None


@pytest.mark.parametrize(
    "message", ["paguei 50 no pix", "gastei 50 no débito", "mercado 50 em dinheiro", "50 da conta"]
)
def test_conta_dita_na_mensagem_fica(message):
    result = classify_with_llm(message, amount=50, account_kind=AccountKindEnum.account)
    assert result.account_kind == AccountKindEnum.account


def test_nome_da_conta_citado_fica_com_o_tipo():
    result = classify_with_llm(
        "gastei 50 na conta principal",
        amount=50,
        account_kind=AccountKindEnum.account,
        account_name="Conta Principal",
    )
    assert result.account_name == "Conta Principal"
    assert result.account_kind == AccountKindEnum.account


def test_cartao_que_o_llm_inventou_e_descartado():
    result = classify_with_llm(
        "gastei 50 no mercado",
        amount=50,
        account_kind=AccountKindEnum.card,
        account_name="Nubank (cartão de crédito)",
    )
    assert result.account_kind is None
    assert result.account_name is None


@pytest.mark.parametrize("message", ["paguei 80 no cartão", "80 no crédito"])
def test_cartao_dito_na_mensagem_fica(message):
    result = classify_with_llm(message, amount=80, account_kind=AccountKindEnum.card)
    assert result.account_kind == AccountKindEnum.card


def test_nome_do_cartao_citado_fica_mesmo_sem_a_palavra_cartao():
    result = classify_with_llm(
        "tv 3000 no nubank",
        amount=3000,
        account_kind=AccountKindEnum.card,
        account_name="Nubank (cartão de crédito)",
    )
    assert result.account_name == "Nubank (cartão de crédito)"
    assert result.account_kind == AccountKindEnum.card
