"""Consumer de entrada: idempotência, ack, retry, DLQ e mídia.

Cobre os casos obrigatórios:

7. reenvio do mesmo ``providerMessageId`` não duplica ``AiMessage``;
9. o consumer só acka depois de persistir e gravar no agrupamento;
10. falha transitória gera retry;
11. tentativas esgotadas enviam para a DLQ;
18. áudio e imagem são processados no consumer, nunca no request HTTP.
"""

from __future__ import annotations

import pytest

from src.consumers import InboundMessageConsumer
from src.messaging.base import ROUTE_INBOUND, ROUTE_PROCESSING
from src.messaging.contracts import InboundMessageV1, ProcessingJobV1
from src.messaging.inmemory import InMemoryPublisher
from src.services.media_resolver import IMAGE_FALLBACK, MediaResolution


def _obj(**attrs):
    """Objeto anônimo com os atributos dados (dublê de um serviço singleton).

    As funções viram ``staticmethod`` para que a chamada não receba ``self``.
    """
    members = {
        name: staticmethod(value) if callable(value) else value
        for name, value in attrs.items()
    }
    return type("Fake", (), members)()


class FakeAudit:
    """Simula ``POST /internal/ai-events`` com a deduplicação real da API."""

    def __init__(self, available: bool = True) -> None:
        self.available = available
        self.seen: dict[str, str] = {}
        self.calls: list[tuple[str, str, str]] = []

    async def log_message_detailed(self, phone, direction, content, metadata=None):
        self.calls.append((phone, direction, content))
        if not self.available:
            return None
        provider_id = (metadata or {}).get("messageId")
        if provider_id and provider_id in self.seen:
            return {"id": self.seen[provider_id], "duplicate": True}
        message_id = f"ai-msg-{len(self.seen) + 1}"
        if provider_id:
            self.seen[provider_id] = message_id
        return {"id": message_id, "conversationId": "conv-1"}

    async def log_message(self, *args, **kwargs):
        return "outbound-id"


@pytest.fixture
def audit(monkeypatch):
    fake = FakeAudit()
    import src.consumers.inbound_consumer as module

    # Substitui o atributo do *módulo*: trocar métodos no singleton deixaria um
    # atributo de instância que vaza para os testes seguintes.
    monkeypatch.setattr(module, "audit_service", fake)
    return fake


@pytest.fixture
def replies(monkeypatch):
    sent: list[tuple[str, str]] = []
    import src.services.message_processor as mp

    async def fake_respond(self, phone, text):
        sent.append((phone, text))
        return text

    monkeypatch.setattr(mp.MessageProcessor, "respond", fake_respond)
    return sent


@pytest.fixture
def consumer(broker, group_store):
    instance = InboundMessageConsumer(InMemoryPublisher(broker), group_store)
    broker.register(ROUTE_INBOUND, instance.handle)
    return instance


async def publish(broker, message: InboundMessageV1) -> None:
    await broker.publish_body(ROUTE_INBOUND, message.model_dump_json(by_alias=True).encode())


def text_message(provider_id: str = "wamid.1", text: str = "gastei 50") -> InboundMessageV1:
    return InboundMessageV1(phone="+5541999999999", text=text, provider_message_id=provider_id)


# ── Idempotência ─────────────────────────────────────────────────────────────
async def test_reenvio_do_mesmo_provider_id_nao_duplica(broker, consumer, group_store, audit):
    await publish(broker, text_message())
    await publish(broker, text_message())
    await broker.drain()

    # A API foi chamada duas vezes, mas só criou uma AiMessage.
    assert len(audit.calls) == 2
    assert len(audit.seen) == 1
    # E o agrupamento recebeu a mensagem uma única vez.
    entries = await group_store.peek("+5541999999999")
    assert len(entries) == 1
    assert len(broker.acked) == 2  # duplicata é sucesso, não reprocessa


# ── Ack e persistência ───────────────────────────────────────────────────────
async def test_acka_somente_apos_persistir_e_agrupar(broker, consumer, group_store, audit):
    await publish(broker, text_message(text="gastei 47,50 no mercado"))
    await broker.drain()

    entries = await group_store.peek("+5541999999999")
    assert len(entries) == 1
    assert entries[0].ai_message_id == "ai-msg-1"
    assert entries[0].provider_message_id == "wamid.1"
    assert entries[0].text == "gastei 47,50 no mercado"
    assert len(broker.acked) == 1


async def test_api_indisponivel_gera_retry_e_nao_acka(broker, consumer, group_store, audit):
    audit.available = False

    await publish(broker, text_message())
    # Uma passada só: o dispatch reagenda em vez de ackar.
    await broker._dispatch(broker.queues[ROUTE_INBOUND].popleft(), consumer.handle)

    assert broker.acked == []
    assert len(broker.retried) == 1
    assert broker.retried[0].attempt == 1
    assert await group_store.peek("+5541999999999") == []


async def test_tentativas_esgotadas_vao_para_a_dlq(broker, consumer, group_store, audit):
    audit.available = False
    broker.max_retries = 3

    await publish(broker, text_message())
    await broker.drain()

    assert broker.acked == []
    assert len(broker.retried) == 2  # tentativas 1 e 2; a 3ª esgota
    assert len(broker.dlq) == 1
    envelope = broker.dlq[0]
    assert envelope.attempts == 3
    assert envelope.permanent is False
    assert envelope.source_queue == ROUTE_INBOUND
    assert envelope.payload["providerMessageId"] == "wamid.1"
    # O erro é sanitizado: nada de payload financeiro no envelope de erro.
    assert "gastei" not in envelope.error_message


async def test_contrato_invalido_vai_direto_para_dlq_sem_retry(broker, consumer, audit):
    await broker.publish_body(ROUTE_INBOUND, b'{"schemaVersion": 99, "phone": ""}')
    await broker.drain()

    assert broker.retried == []
    assert len(broker.dlq) == 1
    assert broker.dlq[0].permanent is True
    assert audit.calls == []


# ── Mídia ────────────────────────────────────────────────────────────────────
async def test_audio_e_transcrito_no_consumer_e_entra_no_agrupamento(
    broker, consumer, group_store, audit, replies, monkeypatch
):
    import src.consumers.inbound_consumer as module

    async def fake_find(phone):
        return {"userId": "u1", "profileType": "personal"}

    async def fake_evaluate(user_id):
        return True, None

    async def fake_resolve(**kwargs):
        assert kwargs["kind"] == "audio"
        assert kwargs["media_id"] == "media-1"
        return MediaResolution(transcript="gastei 30 no almoço", log_content="gastei 30 no almoço")

    monkeypatch.setattr(module, "contact_service", _obj(find_by_phone=fake_find))
    monkeypatch.setattr(module, "subscription_gate", _obj(evaluate=fake_evaluate))
    monkeypatch.setattr(module, "media_resolver", _obj(resolve=fake_resolve))

    await publish(
        broker,
        InboundMessageV1(
            phone="+5541999999999",
            kind="audio",
            media_id="media-1",
            media_mime="audio/ogg",
            provider_message_id="wamid.audio",
        ),
    )
    await broker.drain()

    entries = await group_store.peek("+5541999999999")
    assert len(entries) == 1
    assert entries[0].text == "gastei 30 no almoço"
    # O eco da transcrição é preservado para a resposta final.
    assert entries[0].response_prefix == 'Entendi: "gastei 30 no almoço".\n'


async def test_comprovante_publica_job_proprio_com_intent_e_confirmacao(
    broker, consumer, group_store, audit, replies, monkeypatch
):
    import src.consumers.inbound_consumer as module
    from src.schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum

    intent = FinancialIntent(
        intent=IntentType.create_transaction,
        transaction_type=TransactionTypeEnum.expense,
        amount=120.5,
        description="Supermercado",
        confidence=0.9,
    )

    async def fake_find(phone):
        return {"userId": "u1", "profileType": "personal"}

    async def fake_evaluate(user_id):
        return True, None

    async def fake_resolve(**kwargs):
        return MediaResolution(
            intent=intent, confirm_question="Confirma?", log_content="[comprovante]"
        )

    async def fake_build_context(self, user_id, contact, phone):
        return {"categories": [], "accounts": []}

    import src.services.message_processor as mp

    monkeypatch.setattr(module, "contact_service", _obj(find_by_phone=fake_find))
    monkeypatch.setattr(module, "subscription_gate", _obj(evaluate=fake_evaluate))
    monkeypatch.setattr(module, "media_resolver", _obj(resolve=fake_resolve))
    monkeypatch.setattr(mp.MessageProcessor, "_build_context", fake_build_context)

    await publish(
        broker,
        InboundMessageV1(
            phone="+5541999999999",
            kind="image",
            media_id="media-9",
            provider_message_id="wamid.img",
        ),
    )
    await broker.drain()

    # Comprovante não passa pelo agrupamento: vira job direto.
    assert await group_store.peek("+5541999999999") == []
    jobs = [
        ProcessingJobV1.model_validate_json(m.body) for m in broker.published[ROUTE_PROCESSING]
    ]
    assert len(jobs) == 1
    assert jobs[0].force_confirm is True
    assert jobs[0].confirm_question == "Confirma?"
    assert jobs[0].pre_extracted_intent["amount"] == 120.5


async def test_midia_ilegivel_responde_fallback_e_nao_agrupa(
    broker, consumer, group_store, audit, replies, monkeypatch
):
    import src.consumers.inbound_consumer as module

    async def fake_find(phone):
        return {"userId": "u1"}

    async def fake_evaluate(user_id):
        return True, None

    async def fake_resolve(**kwargs):
        return MediaResolution(fallback_message=IMAGE_FALLBACK)

    async def fake_build_context(self, user_id, contact, phone):
        return {}

    import src.services.message_processor as mp

    monkeypatch.setattr(module, "contact_service", _obj(find_by_phone=fake_find))
    monkeypatch.setattr(module, "subscription_gate", _obj(evaluate=fake_evaluate))
    monkeypatch.setattr(module, "media_resolver", _obj(resolve=fake_resolve))
    monkeypatch.setattr(mp.MessageProcessor, "_build_context", fake_build_context)

    await publish(
        broker,
        InboundMessageV1(phone="+5541999999999", kind="image", media_id="m1"),
    )
    await broker.drain()

    assert replies == [("+5541999999999", IMAGE_FALLBACK)]
    assert await group_store.peek("+5541999999999") == []
    assert len(broker.acked) == 1


async def test_sem_assinatura_nao_baixa_nem_transcreve(
    broker, consumer, group_store, audit, replies, monkeypatch
):
    import src.consumers.inbound_consumer as module

    async def fake_find(phone):
        return {"userId": "u1"}

    async def fake_evaluate(user_id):
        return False, "Assinatura necessária"

    async def explode(**kwargs):
        raise AssertionError("não pode resolver mídia sem assinatura")

    monkeypatch.setattr(module, "contact_service", _obj(find_by_phone=fake_find))
    monkeypatch.setattr(module, "subscription_gate", _obj(evaluate=fake_evaluate))
    monkeypatch.setattr(module, "media_resolver", _obj(resolve=explode))

    await publish(
        broker,
        InboundMessageV1(phone="+5541999999999", kind="audio", media_id="m1"),
    )
    await broker.drain()

    assert replies == [("+5541999999999", "Assinatura necessária")]
    assert audit.calls == []


async def test_tipo_nao_suportado_responde_e_nao_cria_job(broker, consumer, group_store, replies):
    await publish(
        broker,
        InboundMessageV1(phone="+5541999999999", kind="unsupported", raw_type="video"),
    )
    await broker.drain()

    assert len(replies) == 1
    assert await group_store.peek("+5541999999999") == []
    assert broker.published[ROUTE_PROCESSING] == []
