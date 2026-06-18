"""Backend de buffer distribuído em Redis + worker (Etapa 5 do plano).

Substitui o backend em memória para suportar **durabilidade** (sobrevive a
restart), **múltiplas instâncias** (lock distribuído) e **retry/backoff + DLQ**.
Selecionado por ``MESSAGE_BUFFER_BACKEND=redis``.

Estrutura de chaves:
- ``buffer:{phone}``    lista (RPUSH) de mensagens JSON aguardando consolidação;
- ``due``              sorted-set telefone → timestamp de vencimento do debounce;
- ``lock:{phone}``     lock distribuído (SET NX PX) durante o flush;
- ``dlq``              lista de jobs que falharam após todas as tentativas.

O ``redis`` é importado de forma tardia para não ser dependência obrigatória
quando o backend em memória estiver em uso.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

from ..config import settings
from .message_buffer import BufferBackend, BufferedMessage, FlushCallback
from .metrics import metrics

logger = logging.getLogger(__name__)


def _serialize(msg: BufferedMessage) -> str:
    return json.dumps(
        {
            "text": msg.text,
            "persisted_message_id": msg.persisted_message_id,
            "provider_message_id": msg.provider_message_id,
        }
    )


def _deserialize(raw: str) -> BufferedMessage:
    data = json.loads(raw)
    return BufferedMessage(
        text=data["text"],
        persisted_message_id=data.get("persisted_message_id"),
        provider_message_id=data.get("provider_message_id"),
    )


class RedisBufferBackend(BufferBackend):
    def __init__(self, flush_callback: FlushCallback) -> None:
        self._flush = flush_callback
        self._redis = None  # type: ignore[assignment]
        self._worker_task: asyncio.Task | None = None
        self._stopping = False

    async def _client(self):
        if self._redis is None:
            # Import tardio: redis só é necessário neste backend.
            from redis import asyncio as aioredis

            self._redis = aioredis.from_url(
                settings.redis_url, encoding="utf-8", decode_responses=True
            )
        return self._redis

    async def add(self, phone: str, message: BufferedMessage) -> None:
        r = await self._client()
        buf_key = f"buffer:{phone}"
        length = await r.rpush(buf_key, _serialize(message))

        now = time.time()
        if length >= settings.message_buffer_max_messages:
            due = now  # flush imediato ao atingir o limite
        else:
            due = now + settings.message_buffer_debounce_seconds
            # Preserva a idade máxima: não adia além de max_age do 1º item.
            first_due = await r.zscore("due", phone)
            max_due = now + settings.message_buffer_max_age_seconds
            if first_due is None:
                due = min(due, max_due)
            else:
                # mantém o teto de idade já calculado na primeira inserção
                due = min(due, max_due)

        await r.zadd("due", {phone: due})

    # ── Worker ──────────────────────────────────────────────────────────────
    def start_worker(self) -> None:
        if self._worker_task is None:
            self._stopping = False
            self._worker_task = asyncio.ensure_future(self._run_worker())
            logger.info("Worker do buffer Redis iniciado")

    async def stop_worker(self) -> None:
        self._stopping = True
        if self._worker_task is not None:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass
            self._worker_task = None
        if self._redis is not None:
            await self._redis.aclose()

    async def _run_worker(self) -> None:
        while not self._stopping:
            try:
                await self._tick()
            except Exception:  # noqa: BLE001 — worker nunca deve morrer
                logger.exception("Erro no tick do worker de buffer")
            await asyncio.sleep(settings.worker_poll_interval_seconds)

    async def _tick(self) -> None:
        r = await self._client()
        now = time.time()
        due_phones = await r.zrangebyscore("due", "-inf", now)
        for phone in due_phones:
            await self._process_phone(phone)

    async def _process_phone(self, phone: str) -> None:
        r = await self._client()
        lock_key = f"lock:{phone}"
        # Lock distribuído: só uma instância processa o telefone por vez.
        acquired = await r.set(
            lock_key, "1", nx=True, px=settings.redis_lock_ttl_seconds * 1000
        )
        if not acquired:
            return

        try:
            buf_key = f"buffer:{phone}"
            # Drena atomicamente: lê tudo e remove a lista + o agendamento.
            async with r.pipeline(transaction=True) as pipe:
                pipe.lrange(buf_key, 0, -1)
                pipe.delete(buf_key)
                pipe.zrem("due", phone)
                raw_messages, _, _ = await pipe.execute()

            if not raw_messages:
                return

            messages = [_deserialize(m) for m in raw_messages]
            await self._flush_with_retry(phone, messages, raw_messages)
        finally:
            await r.delete(lock_key)

    async def _flush_with_retry(
        self, phone: str, messages: list[BufferedMessage], raw_messages: list[str]
    ) -> None:
        attempts = settings.message_buffer_max_retries
        for attempt in range(1, attempts + 1):
            try:
                await self._flush(phone, messages)
                return
            except Exception:  # noqa: BLE001
                metrics.incr("processing_error")
                logger.exception(
                    "Falha ao processar buffer de %s (tentativa %d/%d)",
                    phone,
                    attempt,
                    attempts,
                )
                if attempt < attempts:
                    backoff = settings.message_buffer_retry_base_seconds * (2 ** (attempt - 1))
                    await asyncio.sleep(backoff)

        # Esgotou as tentativas: envia para a DLQ e segue (não derruba o worker).
        await self._to_dlq(phone, raw_messages)

    async def _to_dlq(self, phone: str, raw_messages: list[str]) -> None:
        r = await self._client()
        job = json.dumps({"phone": phone, "messages": raw_messages, "failed_at": time.time()})
        await r.rpush("dlq", job)
        metrics.incr("dlq")
        logger.error("Job de %s movido para a DLQ após esgotar tentativas", phone)
