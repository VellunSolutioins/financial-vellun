"""Testes do MessageProcessor (Etapa 2): ordem de chamada e caminhos básicos."""

import asyncio

import src.services.message_processor as mp
from src.schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum


class _Recorder:
    def __init__(self):
        self.calls: list[str] = []
        self.sent: list[str] = []


class _FakeGate:
    """Gate de assinatura fake. ``allowed=False`` bloqueia com ``message``."""

    def __init__(self, allowed=True, message=None):
        self._allowed = allowed
        self._message = message

    async def evaluate(self, user_id):
        return (self._allowed, self._message)


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


def test_blocks_without_subscription_before_llm():
    rec = _Recorder()

    class FakeContact:
        async def find_by_phone(self, phone):
            rec.calls.append("contact")
            return {"userId": "u1", "profileType": "personal"}

    class FakeClassifier:
        async def classify(self, message, context):
            rec.calls.append("classify")  # NÃO deve ser chamado
            raise AssertionError("LLM não deve ser chamado sem assinatura")

    class FakeMessenger:
        async def send(self, phone, text):
            rec.sent.append(text)

    class FakeAudit:
        async def log_message(self, *a, **k):
            return "id"

    originals = _patch(
        {
            "contact_service": FakeContact(),
            "intent_classifier": FakeClassifier(),
            "messenger": FakeMessenger(),
            "audit_service": FakeAudit(),
            "subscription_gate": _FakeGate(allowed=False, message="Regularize sua assinatura."),
        }
    )
    try:
        reply = asyncio.run(
            mp.message_processor.process_buffered_message("+5511", "gastei 50", ["m1"])
        )
    finally:
        _restore(originals)

    assert reply == "Regularize sua assinatura."
    assert "classify" not in rec.calls
    assert rec.sent == ["Regularize sua assinatura."]


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
        async def pending_question(self, intent, user_id):
            return None

        async def create_from_intent(self, intent, user_id, raw, **kwargs):
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
    def fake_next_question(intent, message, *, confirmed_total=None):
        return None

    originals = _patch(
        {
            "contact_service": FakeContact(),
            "intent_classifier": FakeClassifier(),
            "transaction_creator": FakeTxCreator(),
            "audit_service": FakeAudit(),
            "messenger": FakeMessenger(),
            "next_question": fake_next_question,
            "subscription_gate": _FakeGate(allowed=True),
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


def test_pending_category_reply_uses_user_categories():
    rec = _Recorder()
    phone = "+5511"

    contact = {"userId": "u1", "profileType": "personal", "contactId": "c1", "linkVersion": 1}

    class FakeContact:
        async def find_by_phone(self, phone):
            return contact

    class FakeTxCreator:
        async def pending_question(self, intent, user_id):
            return None

        async def create_from_intent(self, intent, user_id, raw, **kwargs):
            rec.calls.append(f"create:{intent.category_name}")
            return {"ok": True, "message": f"Criado em {intent.category_name}"}

    class FakeAudit:
        async def log_message(self, *a, **k):
            return "msg-id"

        async def log_extraction(self, *a, **k):
            rec.calls.append("log_extraction")
            return "ext-id"

    class FakeMessenger:
        async def send(self, phone, text):
            rec.sent.append(text)

    originals = _patch(
        {
            "contact_service": FakeContact(),
            "transaction_creator": FakeTxCreator(),
            "audit_service": FakeAudit(),
            "messenger": FakeMessenger(),
            "subscription_gate": _FakeGate(allowed=True),
        }
    )

    async def fake_build_context(self, user_id, contact, phone):
        rec.calls.append("build_context")
        return {"categories": ["Mercado", "Outros"], "recent_messages": []}

    orig_build = mp.MessageProcessor._build_context
    mp.MessageProcessor._build_context = fake_build_context
    pending = FinancialIntent(
        intent=IntentType.create_transaction,
        transaction_type=TransactionTypeEnum.expense,
        amount=50,
        description="Compra teste de R$ 50,00",
        transaction_date="2026-07-07",
        confidence=0.6,
        needs_confirmation=True,
    )
    asyncio.run(mp.conversation_manager.set_pending(phone, pending, contact))
    try:
        reply = asyncio.run(mp.message_processor.process_buffered_message(phone, "Outros", ["m2"]))
    finally:
        asyncio.run(mp.conversation_manager.clear(phone))
        mp.MessageProcessor._build_context = orig_build
        _restore(originals)

    assert reply == "Criado em Outros"
    assert rec.sent == ["Criado em Outros"]
    assert rec.calls == ["build_context", "log_extraction", "create:Outros"]


def test_category_reply_matching_ignores_accents_and_allows_partial_match():
    processor = mp.MessageProcessor()
    assert (
        processor._match_category_reply(
            "servicos essenciais",
            {"categories": ["Serviços essenciais", "Outros"]},
        )
        == "Serviços essenciais"
    )
    assert (
        processor._match_category_reply(
            "serviços essenciais",
            {"categories": ["Serviços", "Outros"]},
        )
        == "Serviços"
    )


def test_movement_between_own_accounts_is_not_registered():
    """Transferência própria, empréstimo, aporte: orienta o app, não cria nada."""
    sent: list[str] = []

    class FakeMessenger:
        async def send(self, phone, text):
            sent.append(text)

    class FakeCreator:
        async def create_from_intent(self, *a, **k):
            raise AssertionError("não deveria criar lançamento")

    class FakeAudit:
        # A entrega registra a saída na auditoria: sem o dublê, o teste chamava
        # a API de verdade (e deixava conexão aberta num loop já fechado).
        async def log_message(self, *a, **k):
            return "id"

    originals = _patch(
        {
            "messenger": FakeMessenger(),
            "transaction_creator": FakeCreator(),
            "audit_service": FakeAudit(),
        }
    )
    try:
        reply = asyncio.run(
            mp.message_processor.handle_intent(
                "+5511",
                "u1",
                FinancialIntent(intent=IntentType.unsupported_movement, amount=500),
                "transferi 500 entre minhas contas",
            )
        )
    finally:
        _restore(originals)

    assert reply == mp.UNSUPPORTED_MOVEMENT_MESSAGE
    assert sent == [mp.UNSUPPORTED_MOVEMENT_MESSAGE]


class _NoCallClassifier:
    async def classify(self, message, context):
        raise AssertionError("Ajuda não passa pelo LLM")


class _NoCallLimiter:
    async def allow(self, phone):
        raise AssertionError("Ajuda não conta no limite diário")


class _FakeConversations:
    def __init__(self, state):
        self.state = state
        self.cleared = False

    async def get(self, phone):
        return self.state

    async def clear(self, phone):
        self.cleared = True


def _run_help(message, *, state=None, gate=None):
    sent: list[str] = []
    contact = {"userId": "u1", "contactId": "c1", "linkVersion": 1, "profileType": "personal"}

    class FakeContact:
        async def find_by_phone(self, phone):
            return contact

    class FakeMessenger:
        async def send(self, phone, text):
            sent.append(text)

    class FakeAudit:
        async def log_message(self, *a, **k):
            return "id"

    conversations = _FakeConversations(state or mp.ConversationState())
    originals = _patch(
        {
            "audit_service": FakeAudit(),
            "contact_service": FakeContact(),
            "intent_classifier": _NoCallClassifier(),
            "usage_limiter": _NoCallLimiter(),
            "conversation_manager": conversations,
            "messenger": FakeMessenger(),
            "subscription_gate": gate or _FakeGate(allowed=True),
        }
    )
    try:
        reply = asyncio.run(mp.message_processor.process_buffered_message("+5511", message, ["m1"]))
    finally:
        _restore(originals)
    return reply, sent, conversations


def test_help_command_answers_without_llm_nor_daily_limit():
    for message in ("ajuda", "Ajuda!", "  MENU ", "?", "como funciona?"):
        reply, sent, _ = _run_help(message)
        assert reply == mp.HELP_MESSAGE
        assert sent == [mp.HELP_MESSAGE]


def test_help_text_shows_examples_of_each_kind():
    for example in ("gastei 50 no mercado", "recebi 3000", "vence dia 20", "em 3x", "todo mês"):
        assert example in mp.HELP_MESSAGE


def test_help_keeps_pending_question_and_reminds_it():
    pending = mp.ConversationState(
        pending_intent=FinancialIntent(intent=IntentType.create_transaction, amount=50),
        awaiting_confirmation=True,
        user_id="u1",
        contact_id="c1",
        link_version=1,
    )
    reply, _, conversations = _run_help("ajuda", state=pending)

    assert reply == mp.HELP_MESSAGE + mp.PENDING_REMINDER
    assert conversations.cleared is False


def test_help_without_subscription_gets_the_block_message():
    reply, _, _ = _run_help("ajuda", gate=_FakeGate(allowed=False, message="Assine o Zeloo."))

    assert reply == "Assine o Zeloo."


def test_only_a_bare_help_request_is_a_command():
    assert mp.is_help_command("ajuda por favor.")
    assert not mp.is_help_command("ajuda com o cartão")
    assert not mp.is_help_command("gastei 50 de ajuda de custo")
