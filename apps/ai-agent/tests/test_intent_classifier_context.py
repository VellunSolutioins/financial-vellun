"""Testes de contexto/histórico no IntentClassifier (Etapa 3)."""

import asyncio

import pytest

from src.schemas.financial_intent import (
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
