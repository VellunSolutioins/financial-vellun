"""Política de ack/retry/DLQ, backoff e shutdown gracioso.

Cobre o caso obrigatório 17 (shutdown devolve jobs não concluídos) e a mecânica
compartilhada por todos os drivers: quando reagenda, quando manda para a DLQ e
quando apenas adia sem consumir tentativa.
"""

from __future__ import annotations

import asyncio

import pytest

from src.messaging.base import (
    HEADER_DEFER_COUNT,
    BrokerMessage,
    DeferError,
    PermanentError,
    dispatch,
)
from src.messaging.inmemory import build_dlq_envelope, sanitize_error
from src.messaging.retry import (
    RETRY_BUCKETS_SECONDS,
    backoff_seconds,
    bucket_for,
    jitter_seconds,
)


def message(attempt: int = 0) -> BrokerMessage:
    return BrokerMessage(body=b'{"a": 1}', routing_key="inbound", attempt=attempt)


class Sink:
    def __init__(self) -> None:
        self.retries: list[tuple[BrokerMessage, bool]] = []
        self.dlq: list[tuple[BrokerMessage, bool]] = []

    async def on_retry(self, msg, exc, count_attempt=True):
        self.retries.append((msg, count_attempt))

    async def on_dlq(self, msg, exc, permanent):
        self.dlq.append((msg, permanent))


# ── Política de dispatch ─────────────────────────────────────────────────────
async def test_sucesso_gera_ack():
    sink = Sink()

    async def handler(_msg):
        return None

    outcome = await dispatch(
        message(), handler, max_retries=3, on_retry=sink.on_retry, on_dlq=sink.on_dlq
    )

    assert outcome == "ack"
    assert sink.retries == [] and sink.dlq == []


async def test_falha_transitoria_gera_retry_contando_tentativa():
    sink = Sink()

    async def handler(_msg):
        raise ConnectionError("API fora do ar")

    outcome = await dispatch(
        message(), handler, max_retries=3, on_retry=sink.on_retry, on_dlq=sink.on_dlq
    )

    assert outcome == "retry"
    assert sink.retries[0][1] is True
    assert sink.dlq == []


async def test_tentativas_esgotadas_vao_para_dlq():
    sink = Sink()

    async def handler(_msg):
        raise TimeoutError("sem resposta")

    outcome = await dispatch(
        message(attempt=2), handler, max_retries=3, on_retry=sink.on_retry, on_dlq=sink.on_dlq
    )

    assert outcome == "dlq"
    assert sink.dlq[0][1] is False  # esgotamento, não falha permanente
    assert sink.retries == []


async def test_falha_permanente_nao_tenta_de_novo():
    sink = Sink()

    async def handler(_msg):
        raise PermanentError("contrato inválido")

    outcome = await dispatch(
        message(), handler, max_retries=5, on_retry=sink.on_retry, on_dlq=sink.on_dlq
    )

    assert outcome == "dlq"
    assert sink.dlq[0][1] is True
    assert sink.retries == []


async def test_adiamento_nao_consome_tentativa():
    sink = Sink()

    async def handler(_msg):
        raise DeferError("telefone ocupado")

    outcome = await dispatch(
        message(attempt=4), handler, max_retries=5, on_retry=sink.on_retry, on_dlq=sink.on_dlq
    )

    assert outcome == "defer"
    assert sink.retries[0][1] is False
    assert sink.dlq == []


async def test_adiamento_em_memoria_incrementa_contador_e_preserva_tentativa(broker):
    async def handler(_msg):
        raise DeferError("ocupado")

    broker.register("inbound", handler)
    await broker.publish_body("inbound", b'{"a": 1}')
    await broker._dispatch(broker.queues["inbound"].popleft(), handler)

    reagendada = broker.retried[0]
    assert reagendada.attempt == 0
    assert reagendada.headers[HEADER_DEFER_COUNT] == 1


# ── Backoff ──────────────────────────────────────────────────────────────────
def test_backoff_e_exponencial_e_limitado():
    assert backoff_seconds(0, 1.0, 300.0) == 1.0
    assert backoff_seconds(3, 1.0, 300.0) == 8.0
    assert backoff_seconds(20, 1.0, 300.0) == 300.0


def test_bucket_escolhido_cobre_o_backoff():
    assert bucket_for(0, 1.0, 300.0) == 1
    assert bucket_for(1, 1.0, 300.0) == 4
    assert bucket_for(4, 1.0, 300.0) == 16
    assert bucket_for(99, 1.0, 300.0) == RETRY_BUCKETS_SECONDS[-1]


def test_jitter_fica_dentro_do_teto():
    assert all(0.0 <= jitter_seconds() < 1.0 for _ in range(50))


# ── Envelope da DLQ ──────────────────────────────────────────────────────────
def test_envelope_da_dlq_tem_o_necessario_para_diagnostico():
    msg = BrokerMessage(
        body=b'{"phone": "+5541999999999"}',
        routing_key="inbound",
        attempt=2,
        correlation_id="corr-1",
    )

    envelope = build_dlq_envelope(msg, ConnectionError("API fora"), False, "whatsapp.inbound.v1")

    assert envelope.source_queue == "whatsapp.inbound.v1"
    assert envelope.routing_key == "inbound"
    assert envelope.attempts == 3
    assert envelope.error_type == "ConnectionError"
    assert envelope.correlation_id == "corr-1"
    assert envelope.payload == {"phone": "+5541999999999"}
    assert envelope.failed_at is not None


def test_envelope_preserva_quando_a_falha_comecou():
    """Regressao: `firstFailedAt` saia sempre nulo do envelope.

    O dado existe — vem do header `x-first-failed-at`, propagado a cada retry —
    mas `build_dlq_envelope` nao o copiava. Sem ele o operador so ve `failedAt`,
    que e a ULTIMA tentativa, e nao consegue distinguir "falhou agora" de "vem
    falhando ha duas horas".
    """
    msg = BrokerMessage(
        body=b'{"phone": "+5541999999999"}',
        routing_key="processing",
        attempt=4,
        first_failed_at="2026-09-05T17:59:12+00:00",
    )

    envelope = build_dlq_envelope(msg, ConnectionError("API fora"), False, "q")

    assert envelope.first_failed_at is not None
    assert envelope.first_failed_at.isoformat() == "2026-09-05T17:59:12+00:00"
    # `failedAt` continua sendo o instante desta ultima falha, e e outro campo.
    assert envelope.failed_at > envelope.first_failed_at


def test_envelope_sem_historico_de_falha_deixa_o_campo_nulo():
    """Primeira falha permanente nunca passou por retry: nao ha o que preservar."""
    msg = BrokerMessage(body=b"{}", routing_key="inbound")

    envelope = build_dlq_envelope(msg, ValueError("contrato invalido"), True, "q")

    assert envelope.first_failed_at is None


def test_envelope_aceita_payload_nao_json():
    envelope = build_dlq_envelope(
        BrokerMessage(body=b"\xff nao json", routing_key="inbound"),
        ValueError("ops"),
        True,
        "q",
    )
    assert "raw" in envelope.payload


def test_mensagem_de_erro_e_truncada():
    assert len(sanitize_error(RuntimeError("x" * 5000))) == 500


# ── Shutdown gracioso (caso 17) ──────────────────────────────────────────────
class FakeIncoming:
    def __init__(self) -> None:
        self.nacked_requeue: bool | None = None
        self.acked = False
        self.headers: dict = {}
        self.body = b"{}"
        self.correlation_id = None

    async def nack(self, requeue: bool = False) -> None:
        self.nacked_requeue = requeue

    async def ack(self) -> None:
        self.acked = True


class FakeQueue:
    def __init__(self) -> None:
        self.cancelled: list[str] = []

    async def cancel(self, tag: str) -> None:
        self.cancelled.append(tag)


class FakeConnection:
    def is_connected(self) -> bool:
        return True


def build_consumer():
    from src.messaging.rabbitmq.consumer import RabbitMqConsumer

    return RabbitMqConsumer(
        FakeConnection(),  # type: ignore[arg-type]
        queue_name="whatsapp.processing.v1",
        routing_key="processing",
        concurrency=2,
        max_retries=3,
        retry_base_seconds=1.0,
        retry_max_seconds=300.0,
    )


async def test_shutdown_devolve_jobs_nao_concluidos():
    consumer = build_consumer()
    queue = FakeQueue()
    consumer._queue = queue
    consumer._tag = "tag-1"
    consumer._accepting = True

    em_voo = FakeIncoming()
    consumer._inflight.add(em_voo)

    await consumer.stop(drain_timeout=0.05)

    assert queue.cancelled == ["tag-1"]
    assert em_voo.nacked_requeue is True  # volta para a fila, não se perde
    assert consumer._inflight == set()
    assert await consumer.healthy() is False


async def test_shutdown_aguarda_o_que_esta_em_voo_terminar():
    consumer = build_consumer()
    consumer._queue = FakeQueue()
    consumer._tag = "tag-1"
    consumer._accepting = True

    em_voo = FakeIncoming()
    consumer._inflight.add(em_voo)

    async def termina_sozinho():
        await asyncio.sleep(0.05)
        consumer._inflight.discard(em_voo)

    await asyncio.gather(consumer.stop(drain_timeout=2.0), termina_sozinho())

    # Terminou dentro do prazo: não precisou ser devolvida.
    assert em_voo.nacked_requeue is None


async def test_nao_aceita_mensagem_nova_durante_o_shutdown():
    consumer = build_consumer()
    consumer._accepting = False
    nova = FakeIncoming()

    await consumer._on_message(nova)  # type: ignore[arg-type]

    assert nova.nacked_requeue is True
    assert nova.acked is False
