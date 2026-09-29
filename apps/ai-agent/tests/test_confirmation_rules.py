"""Regras que decidem entre criar o lançamento direto ou perguntar antes."""

from __future__ import annotations

import pytest

from src.schemas.financial_intent import (
    AmountBasisEnum,
    FinancialIntent,
    IntentType,
    RecurrenceFrequencyEnum,
    RecurrenceTypeEnum,
    TransactionTypeEnum,
)
from src.services.confirmation_rules import (
    FIELD_AMOUNT_BASIS,
    FIELD_CONFIRM,
    FIELD_DATE,
    FIELD_FREQUENCY,
    FIELD_INSTALLMENTS,
    FIELD_OCCURRENCES,
    needs_confirmation,
    next_question,
    total_amount,
)

PERGUNTA_VALOR = "Não identifiquei o valor. Qual foi o valor do lançamento?"


def intent(**overrides) -> FinancialIntent:
    base = dict(
        intent=IntentType.create_transaction,
        transaction_type=TransactionTypeEnum.expense,
        amount=42.9,
        description="padaria",
        category_name="Alimentação",
        confidence=0.9,
    )
    base.update(overrides)
    return FinancialIntent(**base)


def test_lancamento_completo_nao_pergunta():
    assert needs_confirmation(intent(), "gastei 42,90 na padaria") == (False, "")


@pytest.mark.parametrize("amount", [None, 0, 0.0, -10])
def test_valor_ausente_zero_ou_negativo_pergunta_o_valor(amount):
    """O LLM devolve `amount: 0` quando a mensagem não tem valor ("comprei um presente")."""
    assert needs_confirmation(intent(amount=amount), "comprei um presente") == (
        True,
        PERGUNTA_VALOR,
    )


# ── Campo esperado pela pergunta ─────────────────────────────────────────────
def campo(**overrides) -> str | None:
    question = next_question(intent(**overrides), "")
    return question.field if question else None


def test_lancamento_completo_nao_tem_pergunta():
    assert next_question(intent(), "gastei 42,90 na padaria") is None


def test_categoria_ausente_fica_para_o_catalogo():
    # Conta e categoria dependem do catálogo: quem pergunta é o transaction_creator.
    assert next_question(intent(category_name=None)) is None


def test_data_que_nao_e_iso_pede_a_data():
    assert campo(transaction_date="17/06") == FIELD_DATE


def test_data_vaga_pede_a_data():
    question = next_question(intent(), "gastei 50 semana passada")
    assert question is not None and question.field == FIELD_DATE


def test_parcelado_sem_parcelas_pergunta_quantas():
    assert campo(recurrence_type=RecurrenceTypeEnum.parcelado) == FIELD_INSTALLMENTS


def test_parcelado_fora_da_faixa_pergunta_de_novo():
    question = next_question(intent(recurrence_type=RecurrenceTypeEnum.parcelado, installments=99))
    assert question.field == FIELD_INSTALLMENTS
    assert "de 2 a 72" in question.text


def test_parcelado_sem_saber_se_o_valor_e_total_pergunta():
    question = next_question(
        intent(amount=300, recurrence_type=RecurrenceTypeEnum.parcelado, installments=10)
    )
    assert question.field == FIELD_AMOUNT_BASIS
    assert question.text.startswith("R$ 300,00 é o valor total")


def test_parcelado_completo_nao_pergunta():
    assert (
        campo(
            recurrence_type=RecurrenceTypeEnum.parcelado,
            installments=10,
            amount_basis=AmountBasisEnum.total,
        )
        is None
    )


def test_fixo_pergunta_frequencia_e_depois_repeticoes():
    assert campo(recurrence_type=RecurrenceTypeEnum.fixo) == FIELD_FREQUENCY
    assert (
        campo(
            recurrence_type=RecurrenceTypeEnum.fixo,
            recurrence_frequency=RecurrenceFrequencyEnum.monthly,
        )
        == FIELD_OCCURRENCES
    )
    assert (
        campo(
            recurrence_type=RecurrenceTypeEnum.fixo,
            recurrence_frequency=RecurrenceFrequencyEnum.monthly,
            occurrences=12,
        )
        is None
    )


def test_valor_alto_e_baixa_confianca_pedem_confirmacao():
    assert campo(amount=150_000) == FIELD_CONFIRM
    assert campo(confidence=0.3) == FIELD_CONFIRM


def test_parcelado_alto_pelo_total_pede_confirmacao():
    # "3000 por parcela, 60 vezes": a parcela está abaixo do limite, o total não.
    question = next_question(
        intent(
            amount=3000,
            recurrence_type=RecurrenceTypeEnum.parcelado,
            installments=60,
            amount_basis=AmountBasisEnum.installment,
        )
    )
    assert question is not None and question.field == FIELD_CONFIRM
    assert question.text == (
        "O valor total de R$ 180.000,00 (60x de R$ 3.000,00) é alto. Confirma que está correto?"
    )


def test_parcelado_com_total_abaixo_do_limite_nao_pede_confirmacao():
    assert (
        campo(
            amount=3000,
            recurrence_type=RecurrenceTypeEnum.parcelado,
            installments=60,
            amount_basis=AmountBasisEnum.total,
        )
        is None
    )


def test_valor_alto_avulso_mantem_a_mensagem():
    question = next_question(intent(amount=150_000))
    assert question.text == "O valor de R$ 150.000,00 é alto. Confirma que está correto?"


def test_total_do_parcelado_pela_parcela():
    parcela = intent(
        amount=300,
        recurrence_type=RecurrenceTypeEnum.parcelado,
        installments=10,
        amount_basis=AmountBasisEnum.installment,
    )
    assert total_amount(parcela) == 3000
    assert total_amount(intent(amount=300)) == 300
