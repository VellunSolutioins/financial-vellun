"""Testes do MessageProcessor (Etapa 2): ordem de chamada e caminhos básicos."""

import asyncio

import src.services.message_processor as mp
from src.schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum


class _Recorder:
    def __init__(self):
        self.calls: list[str] = []
        self.sent: list[str] = []


def _patch(monkeypatch_targets: dict):
    originals = {name: getattr(mp, name) for name in monkeypatch_targets}
    for name, value in monkeypatch_targets.items():
        setattr(mp, name, value)
    return originals


def _restore(originals: dict):
    for name, value in originals.items():
        setattr(mp, name, value)


def test_not_linked_contact_returns_guidance():
    rec = _Recorder()

    class FakeContact:
        async def find_by_phone(self, phone):
            rec.calls.append("find_by_phone")
            return None

    class FakeMessenger:
        async def send(self, phone, text):
            rec.sent.append(text)

    class FakeAudit:
        async def log_message(self, *a, **k):
            return "id"

    originals = _patch(
        {
            "contact_service": FakeContact(),
            "messenger": FakeMessenger(),
            "audit_service": FakeAudit(),
        }
    )
    try:
        reply = asyncio.run(
            mp.message_processor.process_buffered_message("+5511", "oi", ["m1"])
        )
    finally:
        _restore(originals)

    assert reply == mp.NOT_LINKED_MESSAGE
    assert rec.sent == [mp.NOT_LINKED_MESSAGE]
    assert rec.calls == ["find_by_phone"]


def test_happy_path_calls_services_in_order():
    rec = _Recorder()

    class FakeContact:
        async def find_by_phone(self, phone):
            rec.calls.append("contact")
            return {"userId": "u1", "profileType": "personal"}

    class FakeClassifier:
        async def classify(self, message, context):
            rec.calls.append("classify")
            return FinancialIntent(
                intent=IntentType.create_transaction,
                transaction_type=TransactionTypeEnum.expense,
                amount=47.5,
                category_name="Mercado",
                transaction_date="2026-06-18",
                confidence=0.95,
            )

    class FakeTxCreator:
        async def create_from_intent(self, intent, user_id, raw, ai_extracted_transaction_id=None):
            rec.calls.append("create_transaction")
            return {"ok": True, "message": "Lançamento criado!"}

    class FakeAudit:
        async def log_message(self, *a, **k):
            return "msg-id"

        async def log_message_detailed(self, *a, **k):
            return {"id": "msg-id"}

        async def log_extraction(self, *a, **k):
            rec.calls.append("log_extraction")
            return "ext-id"

    class FakeMessenger:
        async def send(self, phone, text):
            rec.calls.append("send")
            rec.sent.append(text)

    # Sem confirmação necessária.
    def fake_needs_confirmation(intent, message):
        return (False, "")

    originals = _patch(
        {
            "contact_service": FakeContact(),
            "intent_classifier": FakeClassifier(),
            "transaction_creator": FakeTxCreator(),
            "audit_service": FakeAudit(),
            "messenger": FakeMessenger(),
            "needs_confirmation": fake_needs_confirmation,
        }
    )

    # _build_context consulta api_client/histórico; injeta contexto vazio.
    async def fake_build_context(self, user_id, contact, phone):
        rec.calls.append("build_context")
        return {"recent_messages": []}

    orig_build = mp.MessageProcessor._build_context
    mp.MessageProcessor._build_context = fake_build_context
    try:
        reply = asyncio.run(
            mp.message_processor.process_buffered_message("+5511", "gastei 47,50 no mercado", ["m1"])
        )
    finally:
        mp.MessageProcessor._build_context = orig_build
        _restore(originals)

    assert reply == "Lançamento criado!"
    assert rec.calls == [
        "contact",
        "build_context",
        "classify",
        "log_extraction",
        "create_transaction",
        "send",
    ]
