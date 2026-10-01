"""Ponta a ponta com RabbitMQ e Redis **reais**: o percurso do incidente.

O e2e em memória (``test_pipeline_end_to_end.py``) prova a lógica. Este prova o
que o dublê não tem: topologia declarada no broker, *publisher confirms*, ack,
dead-letter de verdade, o agrupamento, o lock e a resposta guardada no Redis.
Os dublês são os mesmos: API principal, LLM e WhatsApp.

As filas levam o prefixo ``test.e2e.`` e são apagadas ao final. A exchange é a
mesma do agente (``whatsapp.x``), então, com um agente de desenvolvimento
ligado no mesmo broker, as filas dele também recebem uma cópia da mensagem de
teste (de ``+5541999999999``, não vinculado). No CI não há outro agente.

    pnpm db:up
    cd apps/ai-agent && .venv/Scripts/python.exe -m pytest -m integration -q
"""

from __future__ import annotations

import pytest

from src.bootstrap import pipeline
from src.config import settings
from src.messaging.base import PermanentError
from src.messaging.contracts import DlqEnvelopeV1
from src.messaging.names import all_retry_queues, dlq_queue
from src.services.distributed_state import get_state_store
from tests.integration_env import RABBITMQ_URL, REDIS_URL, unavailable
from tests.pipeline_support import PHONE, Mundo, esperar, instalar_mundo, postar_webhook

pytestmark = pytest.mark.integration

FILAS = {
    "rabbitmq_inbound_queue": "test.e2e.inbound.v1",
    "rabbitmq_processing_queue": "test.e2e.processing.v1",
    "rabbitmq_outbound_queue": "test.e2e.outbound.v1",
}
# Mais folga que em memória: aqui há rede, ack e o tick do flusher.
PRAZO = 20.0


def _todas_as_filas() -> list[str]:
    nomes = []
    for fila in FILAS.values():
        nomes += [fila, dlq_queue(fila), *(nome for nome, _ in all_retry_queues(fila))]
    return nomes


async def _apagar_filas() -> None:
    from src.messaging.rabbitmq import RabbitConnection

    conn = RabbitConnection(RABBITMQ_URL, prefetch=1)
    await conn.connect(max_attempts=1, base_delay=0.1)
    try:
        channel = await conn.publish_channel()
        for nome in _todas_as_filas():
            try:
                await channel.queue_delete(nome)
            except Exception:  # noqa: BLE001 - fila que não existe
                channel = await conn.publish_channel()
    finally:
        await conn.close()


async def _limpar_redis() -> None:
    from redis import asyncio as aioredis

    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    try:
        await client.delete(f"conv:{PHONE}")
        await client.zrem("group:due", PHONE)
        for padrao in (f"group:*{PHONE}*", f"*lock*{PHONE}*"):
            async for chave in client.scan_iter(match=padrao):
                await client.delete(chave)
    finally:
        await client.aclose()


@pytest.fixture
async def infra_real(monkeypatch):
    """Troca os backends em memória do ``conftest`` pelos reais."""
    import src.messaging.factory as factory
    from src.grouping import set_group_store
    from src.services.conversation_manager import conversation_manager
    from src.services.distributed_state import set_state_store
    from src.services.redis_client import redis_provider

    try:
        await _apagar_filas()
    except Exception as exc:  # noqa: BLE001
        unavailable("RabbitMQ", exc)
    try:
        await _limpar_redis()
    except Exception as exc:  # noqa: BLE001
        unavailable("Redis", exc)

    monkeypatch.setattr(settings, "message_broker", "rabbitmq")
    monkeypatch.setattr(settings, "rabbitmq_url", RABBITMQ_URL)
    monkeypatch.setattr(settings, "redis_url", REDIS_URL)
    monkeypatch.setattr(settings, "group_store_backend", "redis")
    monkeypatch.setattr(settings, "conversation_state_backend", "redis")
    for campo, fila in FILAS.items():
        monkeypatch.setattr(settings, campo, fila)
    # O provider global guardou a URL no import; o teste manda.
    monkeypatch.setattr(redis_provider, "_url", REDIS_URL)
    await redis_provider.close()

    factory._rabbit_conn = None
    set_group_store(None)
    set_state_store(None)
    conversation_manager.use_store(None)

    yield

    factory._rabbit_conn = None
    await _limpar_redis()
    await _apagar_filas()


@pytest.fixture
def mundo(monkeypatch) -> Mundo:
    return instalar_mundo(monkeypatch)


@pytest.fixture
async def pipeline_real(infra_real, mundo):
    await pipeline.start_consumers()
    try:
        yield pipeline
    finally:
        await pipeline.stop()


async def _mensagem_na_dlq(fila: str) -> DlqEnvelopeV1 | None:
    """Lê (sem consumir de vez) a primeira mensagem da DLQ de ``fila``."""
    from src.messaging.rabbitmq import RabbitConnection

    conn = RabbitConnection(RABBITMQ_URL, prefetch=1)
    await conn.connect(max_attempts=1, base_delay=0.1)
    try:
        channel = await conn.publish_channel()
        queue = await channel.get_queue(dlq_queue(fila), ensure=False)
        bruto = await queue.get(no_ack=True, fail=False)
        if bruto is None:
            return None
        return DlqEnvelopeV1.model_validate_json(bruto.body)
    finally:
        await conn.close()


async def test_mensagem_do_webhook_vira_lancamento_e_resposta(pipeline_real, mundo):
    resposta = await postar_webhook()

    assert resposta.status_code == 202
    await esperar(lambda: mundo.entregues, timeout=PRAZO)

    assert mundo.persistidas == ["gastei 47,50 no mercado"]
    assert len(mundo.criados) == 1
    assert mundo.entregues == [(PHONE, "Lançamento criado!")]

    # O job é marcado como concluído no Redis. A entrega corre em outra fila e
    # pode chegar antes dessa marca: espera em vez de afirmar na hora.
    job_id = next(iter(mundo.criados))
    await esperar(lambda: get_state_store().exists(f"job:done:{job_id}"), timeout=PRAZO)


async def test_recusa_do_whatsapp_vai_para_a_dlq_sem_perder_o_lancamento(pipeline_real, mundo):
    mundo.recusa = PermanentError("WhatsApp Cloud API recusou envio: HTTP 401")

    assert (await postar_webhook()).status_code == 202

    envelopes: list[DlqEnvelopeV1] = []

    async def chegou_na_dlq() -> bool:
        envelope = await _mensagem_na_dlq(FILAS["rabbitmq_outbound_queue"])
        if envelope is not None:
            envelopes.append(envelope)
        return bool(envelopes)

    await esperar(chegou_na_dlq, timeout=PRAZO)

    envelope = envelopes[0]
    assert envelope.permanent is True
    assert envelope.payload["phone"] == PHONE
    assert len(mundo.criados) == 1  # o lançamento existe; só a entrega falhou
    assert mundo.entregues == []

    job_id = envelope.payload["jobId"]
    await esperar(lambda: get_state_store().exists(f"job:done:{job_id}"), timeout=PRAZO)
