"""Testes de integração com RabbitMQ e Redis reais.

Ficam fora da execução padrão (marcador ``integration``). Para rodar:

    pnpm db:up
    cd apps/ai-agent && .venv/Scripts/python.exe -m pytest -m integration -q

Verificam o que o dublê em memória não cobre: declaração da topologia,
*publisher confirms* de verdade, TTL das filas de retry, dead-letter exchange e
o comportamento real do Redis (agrupamento, locks e estado de conversa).
"""

from __future__ import annotations

import asyncio
import os

import pytest

from src.messaging.contracts import InboundMessageV1
from src.messaging.names import EXCHANGE_MAIN, dlq_queue, retry_queue

pytestmark = pytest.mark.integration

QUEUE = "test.whatsapp.inbound.v1"
ROUTING_KEY = "test.inbound"

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@localhost:5672/")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")


@pytest.fixture
async def connection():
    from src.messaging.rabbitmq import RabbitConnection

    conn = RabbitConnection(RABBITMQ_URL, prefetch=5)
    try:
        await conn.connect(max_attempts=1, base_delay=0.1)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"RabbitMQ indisponível em {RABBITMQ_URL}: {exc}")

    yield conn

    channel = await conn.publish_channel()
    for name in (QUEUE, dlq_queue(QUEUE), *(q for q, _ in _retry_queues())):
        try:
            await channel.queue_delete(name)
        except Exception:  # noqa: BLE001
            pass
    await conn.close()


def _retry_queues():
    from src.messaging.names import all_retry_queues

    return all_retry_queues(QUEUE)


@pytest.fixture
async def topology(connection):
    from src.messaging.rabbitmq import declare_topology

    channel = await connection.publish_channel()
    await declare_topology(channel, [(QUEUE, ROUTING_KEY)])
    # Começa sempre de um estado limpo.
    for name in (QUEUE, dlq_queue(QUEUE)):
        queue = await channel.get_queue(name, ensure=False)
        await queue.purge()
    return connection


@pytest.fixture
async def redis_client():
    from redis import asyncio as aioredis

    client = aioredis.from_url(REDIS_URL, encoding="utf-8", decode_responses=True)
    try:
        await client.ping()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Redis indisponível em {REDIS_URL}: {exc}")
    yield client
    await client.aclose()


def build_consumer(connection, max_retries: int = 2):
    from src.messaging.rabbitmq import RabbitMqConsumer

    return RabbitMqConsumer(
        connection,
        queue_name=QUEUE,
        routing_key=ROUTING_KEY,
        concurrency=2,
        max_retries=max_retries,
        retry_base_seconds=1.0,
        retry_max_seconds=300.0,
    )


async def publish(connection, message: InboundMessageV1) -> None:
    import aio_pika

    channel = await connection.publish_channel()
    exchange = await channel.get_exchange(EXCHANGE_MAIN, ensure=False)
    await exchange.publish(
        aio_pika.Message(
            body=message.model_dump_json(by_alias=True).encode(),
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            content_type="application/json",
        ),
        routing_key=ROUTING_KEY,
    )


async def wait_for(predicate, timeout: float = 20.0) -> bool:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.1)
    return False


# ── RabbitMQ ─────────────────────────────────────────────────────────────────
async def test_topologia_declarada_e_mensagem_persistente_entregue(topology):
    connection = topology
    received: list[InboundMessageV1] = []

    async def handler(broker_message):
        received.append(InboundMessageV1.model_validate_json(broker_message.body))

    consumer = build_consumer(connection)
    await consumer.start(handler)
    try:
        await publish(connection, InboundMessageV1(phone="+5541999999999", text="oi"))
        assert await wait_for(lambda: len(received) == 1)
        assert received[0].text == "oi"
    finally:
        await consumer.stop(drain_timeout=2.0)


async def test_falha_transitoria_volta_pela_fila_de_retry(topology):
    connection = topology
    tentativas: list[int] = []

    async def handler(broker_message):
        tentativas.append(broker_message.attempt)
        if len(tentativas) == 1:
            raise ConnectionError("API fora do ar")

    consumer = build_consumer(connection, max_retries=3)
    await consumer.start(handler)
    try:
        await publish(connection, InboundMessageV1(phone="+5541999999999", text="oi"))
        # O bucket de 1s precisa expirar e a DLX devolver a mensagem.
        assert await wait_for(lambda: len(tentativas) == 2, timeout=25.0)
        assert tentativas == [0, 1]
    finally:
        await consumer.stop(drain_timeout=2.0)


async def test_tentativas_esgotadas_chegam_na_dlq(topology):
    connection = topology

    async def handler(_broker_message):
        raise TimeoutError("sempre falha")

    consumer = build_consumer(connection, max_retries=1)  # esgota na primeira
    await consumer.start(handler)
    try:
        await publish(connection, InboundMessageV1(phone="+5541999999999", text="oi"))

        channel = await connection.publish_channel()
        dlq = await channel.get_queue(dlq_queue(QUEUE), ensure=False)

        envelope = None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 20.0
        while loop.time() < deadline and envelope is None:
            envelope = await dlq.get(no_ack=True, fail=False)
            if envelope is None:
                await asyncio.sleep(0.2)

        assert envelope is not None, "a mensagem nao chegou a DLQ"
        assert b'"errorType"' in envelope.body
        assert b'"sourceQueue"' in envelope.body
    finally:
        await consumer.stop(drain_timeout=2.0)


async def test_envelope_da_dlq_preserva_quando_a_falha_comecou(topology):
    """`firstFailedAt` sobrevive a viagem pela fila de retry ate a DLQ.

    O caminho real e o que importa aqui: a informacao viaja no header
    `x-first-failed-at`, escrito no primeiro retry e relido a cada reentrega. O
    teste com `max_retries=1` acima esgota na primeira tentativa e nunca passa
    pela fila de retry, entao nao exercita esse trecho.

    Sem isso o operador so enxerga `failedAt` — a ULTIMA tentativa — e nao
    distingue uma falha nova de uma que vem se arrastando.
    """
    import json

    connection = topology

    async def handler(_broker_message):
        raise TimeoutError("sempre falha")

    # 2 tentativas: a primeira agenda o retry (escreve o header), a segunda esgota.
    consumer = build_consumer(connection, max_retries=2)
    await consumer.start(handler)
    try:
        await publish(connection, InboundMessageV1(phone="+5541999999999", text="oi"))

        channel = await connection.publish_channel()
        dlq = await channel.get_queue(dlq_queue(QUEUE), ensure=False)

        bruto = None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 30.0
        while loop.time() < deadline and bruto is None:
            bruto = await dlq.get(no_ack=True, fail=False)
            if bruto is None:
                await asyncio.sleep(0.2)

        assert bruto is not None, "a mensagem nao chegou a DLQ"
        envelope = json.loads(bruto.body)

        assert envelope["attempts"] == 2
        assert envelope["firstFailedAt"] is not None, "firstFailedAt veio nulo"
        # Sao campos distintos: o primeiro tropeco e a desistencia final.
        assert envelope["firstFailedAt"] <= envelope["failedAt"]
    finally:
        await consumer.stop(drain_timeout=2.0)


async def test_filas_de_retry_existem_com_ttl(topology):
    connection = topology
    channel = await connection.publish_channel()

    for name, bucket in _retry_queues():
        assert name == retry_queue(QUEUE, bucket)
        # `passive` só passa se a fila existir com exatamente estes argumentos.
        await channel.declare_queue(name, durable=True, passive=True)


# ── Redis ────────────────────────────────────────────────────────────────────
async def test_agrupamento_no_redis_preserva_ordem_e_lock(redis_client, monkeypatch):
    from src.grouping import GroupEntry
    from src.grouping.redis_store import RedisGroupStore
    from src.services.redis_client import RedisProvider

    phone = "+5541900000001"
    store = RedisGroupStore(RedisProvider(REDIS_URL))
    await store.clear(phone)

    for index, text in enumerate(["gastei", "47,50", "no mercado"], start=1):
        await store.append(phone, GroupEntry(text=text, ai_message_id=f"ai-{index}"))

    entries = await store.peek(phone)
    assert [e.text for e in entries] == ["gastei", "47,50", "no mercado"]

    assert await store.acquire_lock(phone, 10) is True
    assert await store.acquire_lock(phone, 10) is False  # exclusão mútua real
    await store.release_lock(phone)
    assert await store.acquire_lock(phone, 10) is True
    await store.release_lock(phone)

    await store.clear(phone)
    assert await store.peek(phone) == []


async def test_append_deduplica_por_provider_message_id_no_redis(redis_client):
    """O RPUSH condicional roda como script Lua — só o Redis real o exercita."""
    from src.grouping import GroupEntry
    from src.grouping.redis_store import DUE_KEY, RedisGroupStore
    from src.services.redis_client import RedisProvider

    phone = "+5541900000005"
    store = RedisGroupStore(RedisProvider(REDIS_URL))
    await store.clear(phone)

    entry = GroupEntry(text="gastei 10", ai_message_id="ai-1", provider_message_id="wamid.1")
    primeiro = await store.append(phone, entry)
    vencimento = await redis_client.zscore(DUE_KEY, phone)
    repetido = await store.append(phone, entry)

    assert (primeiro.length, primeiro.added) == (1, True)
    assert (repetido.length, repetido.added) == (1, False)
    assert len(await store.peek(phone)) == 1
    # A duplicata não reagenda o flush: o vencimento vigente continua valendo.
    assert await redis_client.zscore(DUE_KEY, phone) == vencimento

    # Outro providerMessageId entra normalmente.
    outro = await store.append(
        phone, GroupEntry(text="no mercado", ai_message_id="ai-2", provider_message_id="wamid.2")
    )
    assert (outro.length, outro.added) == (2, True)

    await store.clear(phone)


async def test_confirmacao_pendente_sobrevive_no_redis(redis_client):
    from src.schemas.financial_intent import FinancialIntent, IntentType
    from src.services.conversation_manager import ConversationManager
    from src.services.conversation_store import RedisConversationStore
    from src.services.redis_client import RedisProvider

    phone = "+5541900000002"
    store = RedisConversationStore(RedisProvider(REDIS_URL))
    await store.clear(phone)

    intent = FinancialIntent(
        intent=IntentType.create_transaction, amount=47.5, confidence=0.6, needs_confirmation=True
    )
    await ConversationManager(store).set_pending(phone, intent)

    # Outro processo (store novo, manager novo) enxerga a confirmação pendente.
    outro = ConversationManager(RedisConversationStore(RedisProvider(REDIS_URL)))
    estado = await outro.get(phone)

    assert estado.awaiting_confirmation is True
    assert estado.pending_intent is not None
    assert estado.pending_intent.amount == 47.5

    await store.clear(phone)


async def test_lock_de_processamento_e_marcador_de_job_no_redis(redis_client):
    from src.services.distributed_state import RedisStateStore
    from src.services.redis_client import RedisProvider

    store = RedisStateStore(RedisProvider(REDIS_URL))
    lock = "test:proc:lock:+5541900000003"
    marker = "test:job:done:abc"
    await store.release(lock)
    await store.release(marker)

    assert await store.acquire(lock, 10) is True
    assert await store.acquire(lock, 10) is False
    await store.release(lock)

    assert await store.exists(marker) is False
    await store.mark(marker, 30)
    assert await store.exists(marker) is True
    await store.release(marker)


async def test_fatiamento_do_grupo_no_redis(redis_client):
    """`peek(limit)` + `consume` usam LRANGE/LTRIM de verdade."""
    from src.config import settings
    from src.grouping import GroupEntry
    from src.grouping.redis_store import DUE_KEY, RedisGroupStore
    from src.services.redis_client import RedisProvider

    phone = "+5541900000004"
    store = RedisGroupStore(RedisProvider(REDIS_URL))
    await store.clear(phone)

    for index in range(1, 13):
        await store.append(phone, GroupEntry(text=f"msg{index}", ai_message_id=f"ai-{index}"))

    fatia = await store.peek(phone, limit=settings.message_buffer_max_messages)
    assert [e.text for e in fatia] == [f"msg{i}" for i in range(1, 11)]

    restantes = await store.consume(phone, len(fatia))
    assert restantes == 2
    assert [e.text for e in await store.peek(phone)] == ["msg11", "msg12"]
    # Continua agendado, com o teto de idade contando do novo inicio.
    assert await redis_client.zscore(DUE_KEY, phone) is not None

    assert await store.consume(phone, 2) == 0
    assert await store.peek(phone) == []
    assert await redis_client.zscore(DUE_KEY, phone) is None
