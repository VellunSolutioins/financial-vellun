"""Regras que decidem entre criar o lançamento direto ou perguntar antes."""

from __future__ import annotations

import pytest

from src.schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum
from src.services.confirmation_rules import needs_confirmation

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
