"""Testes do interpretador baseado em regras (P3.3).

Forçam o modo apenas-regras com ``IntentClassifier(provider=None)`` para
serem determinísticos e independentes de `OPENAI_API_KEY`.
"""

import asyncio
from datetime import date, timedelta

from src.schemas.financial_intent import IntentType, TransactionTypeEnum
from src.services.intent_classifier import IntentClassifier

classifier = IntentClassifier(provider=None)


def classify(message: str, context: dict | None = None):
    return asyncio.run(classifier.classify(message, context or {}))


def test_expense_with_category():
    result = classify("gastei 100 no mercado")
    assert result.intent == IntentType.create_transaction
    assert result.transaction_type == TransactionTypeEnum.expense
    assert result.amount == 100
    assert result.category_name == "Mercado"
    assert result.confidence >= 0.8
    assert result.needs_confirmation is False


def test_income_salary():
    result = classify("recebi 5000 de salário")
    assert result.transaction_type == TransactionTypeEnum.income
    assert result.amount == 5000
    assert result.category_name == "Salário"


def test_expense_without_category_needs_confirmation():
    result = classify("paguei 300")
    assert result.needs_confirmation is True


def test_decimal_amount_and_relative_date():
    result = classify("gastei 47,50 no almoço ontem")
    assert result.amount == 47.5
    assert result.category_name == "Alimentação"
    expected = (date.today() - timedelta(days=1)).isoformat()
    assert result.transaction_date == expected


def test_help_intent():
    result = classify("preciso de ajuda")
    assert result.intent == IntentType.help


def test_query_summary_intent():
    result = classify("qual meu saldo?")
    assert result.intent == IntentType.query_summary
