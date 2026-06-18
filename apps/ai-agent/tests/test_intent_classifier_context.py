"""Testes de contexto/histórico no IntentClassifier (Etapa 3)."""

import asyncio

from src.schemas.financial_intent import FinancialIntent, IntentType
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
