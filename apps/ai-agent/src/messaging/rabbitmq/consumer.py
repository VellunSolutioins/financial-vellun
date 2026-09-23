"""Consumer RabbitMQ com ack manual, retry por bucket e DLQ.

Regras:

- ack só depois que o efeito da etapa está duravelmente concluído;
- falha transitória republica na fila de retry do bucket correspondente
  (backoff exponencial + jitter) e acka a original, para não travar a fila;
- falha permanente ou tentativas esgotadas publica o envelope na DLQ e acka;
- shutdown: cancela o consumo, aguarda o que está em voo e devolve
  (``nack requeue``) o que não terminou dentro do prazo.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import aio_pika
from aio_pika.abc import AbstractIncomingMessage

from ..base import (
    HEADER_ATTEMPT,
    HEADER_DEFER_COUNT,
    HEADER_FIRST_FAILED_AT,
    BrokerMessage,
    MessageConsumer,
    MessageHandler,
    dispatch,
)
from ..contracts import utcnow
from ..inmemory import build_dlq_envelope
from ..names import EXCHANGE_DLX, EXCHANGE_RETRY, dlq_routing_key, retry_routing_key
from ..retry import RETRY_BUCKETS_SECONDS, bucket_for, jitter_seconds
from .connection import RabbitConnection

logger = logging.getLogger(__name__)


class RabbitMqConsumer(MessageConsumer):
    def __init__(
        self,
        connection: RabbitConnection,
        *,
        queue_name: str,
        routing_key: str,
        concurrency: int,
        max_retries: int,
        retry_base_seconds: float,
        retry_max_seconds: float,
    ) -> None:
        self._conn = connection
        self._queue_name = queue_name
        self._routing_key = routing_key
        self._max_retries = max_retries
        self._retry_base = retry_base_seconds
        self._retry_max = retry_max_seconds
        self._semaphore = asyncio.Semaphore(concurrency)
        self._queue: Any = None
        self._tag: str | None = None
        self._handler: MessageHandler | None = None
        self._inflight: set[AbstractIncomingMessage] = set()
        self._accepting = False

    async def start(self, handler: MessageHandler) -> None:
        self._handler = handler
        channel = await self._conn.consume_channel()
        self._queue = await channel.get_queue(self._queue_name, ensure=False)
        self._accepting = True
        self._tag = await self._queue.consume(self._on_message, no_ack=False)
        logger.info("Consumindo %s (tag=%s)", self._queue_name, self._tag)

    async def stop(self, drain_timeout: float = 20.0) -> None:
        self._accepting = False
        if self._queue is not None and self._tag is not None:
            try:
                await self._queue.cancel(self._tag)
            except Exception:  # noqa: BLE001 — shutdown não deve falhar
                logger.debug("Erro ao cancelar consumo de %s", self._queue_name, exc_info=True)
            self._tag = None

        loop = asyncio.get_running_loop()
        deadline = loop.time() + drain_timeout
        while self._inflight and loop.time() < deadline:
            await asyncio.sleep(0.1)

        # O que não terminou volta para a fila: nenhuma mensagem confirmada se perde.
        for message in list(self._inflight):
            try:
                await message.nack(requeue=True)
            except Exception:  # noqa: BLE001
                logger.debug("Erro ao devolver mensagem em voo", exc_info=True)
        if self._inflight:
            logger.warning(
                "%d mensagem(ns) devolvida(s) a fila %s no shutdown",
                len(self._inflight),
                self._queue_name,
            )
        self._inflight.clear()

    async def healthy(self) -> bool:
        return self._accepting and self._conn.is_connected()

    async def _on_message(self, message: AbstractIncomingMessage) -> None:
        if not self._accepting:
            await message.nack(requeue=True)
            return

        assert self._handler is not None
        self._inflight.add(message)
        try:
            async with self._semaphore:
                broker_message = _to_broker_message(message, self._queue_name)
                outcome = await dispatch(
                    broker_message,
                    self._handler,
                    max_retries=self._max_retries,
                    on_retry=self._republish_for_retry,
                    on_dlq=self._publish_to_dlq,
                )
            # Em todos os desfechos a responsabilidade já foi transferida
            # (processada, reagendada no retry ou registrada na DLQ).
            await message.ack()
            logger.debug("Mensagem de %s finalizada como %s", self._queue_name, outcome)
        except Exception:  # noqa: BLE001 — falha na própria mecânica de ack
            logger.exception("Erro ao finalizar mensagem de %s; devolvendo", self._queue_name)
            try:
                await message.nack(requeue=True)
            except Exception:  # noqa: BLE001
                logger.debug("Erro ao devolver mensagem", exc_info=True)
        finally:
            self._inflight.discard(message)

    async def _republish_for_retry(
        self, broker_message: BrokerMessage, exc: BaseException, count_attempt: bool = True
    ) -> None:
        # Adiamento por concorrência não consome tentativa e volta no menor bucket.
        next_attempt = broker_message.attempt + 1 if count_attempt else broker_message.attempt
        bucket = (
            bucket_for(broker_message.attempt, self._retry_base, self._retry_max)
            if count_attempt
            else RETRY_BUCKETS_SECONDS[0]
        )
        await asyncio.sleep(jitter_seconds())

        channel = await self._conn.publish_channel()
        exchange = await channel.get_exchange(EXCHANGE_RETRY, ensure=False)
        headers = {
            **broker_message.headers,
            HEADER_ATTEMPT: next_attempt,
            HEADER_FIRST_FAILED_AT: broker_message.first_failed_at or utcnow().isoformat(),
        }
        if not count_attempt:
            headers[HEADER_DEFER_COUNT] = int(headers.get(HEADER_DEFER_COUNT, 0) or 0) + 1
        await exchange.publish(
            aio_pika.Message(
                body=broker_message.body,
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                correlation_id=broker_message.correlation_id,
                headers=headers,
                # O timestamp é o da **republicação**, não o da mensagem
                # original: a idade que interessa na fila de retry é há quanto
                # tempo esta tentativa espera. O tempo total desde a primeira
                # falha já está em `x-first-failed-at`.
                timestamp=datetime.now(timezone.utc),
            ),
            routing_key=retry_routing_key(self._routing_key, bucket),
        )
        logger.info(
            "Retry agendado para %s em %ds (tentativa %d)",
            self._queue_name,
            bucket,
            next_attempt,
        )

    async def _publish_to_dlq(
        self, broker_message: BrokerMessage, exc: BaseException, permanent: bool
    ) -> None:
        envelope = build_dlq_envelope(broker_message, exc, permanent, self._queue_name)
        channel = await self._conn.publish_channel()
        exchange = await channel.get_exchange(EXCHANGE_DLX, ensure=False)
        await exchange.publish(
            aio_pika.Message(
                body=envelope.model_dump_json(by_alias=True).encode(),
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                correlation_id=broker_message.correlation_id,
                timestamp=datetime.now(timezone.utc),
            ),
            routing_key=dlq_routing_key(self._routing_key),
        )
        logger.error(
            "Mensagem de %s enviada para a DLQ (permanente=%s, tentativas=%d)",
            self._queue_name,
            permanent,
            envelope.attempts,
        )


def _to_broker_message(message: AbstractIncomingMessage, queue_name: str) -> BrokerMessage:
    headers = dict(message.headers or {})
    raw_attempt = headers.get(HEADER_ATTEMPT, 0)
    try:
        attempt = int(raw_attempt)
    except (TypeError, ValueError):
        attempt = 0
    first_failed = headers.get(HEADER_FIRST_FAILED_AT)
    return BrokerMessage(
        body=message.body,
        routing_key=queue_name,
        attempt=attempt,
        correlation_id=message.correlation_id,
        headers=headers,
        first_failed_at=str(first_failed) if first_failed else None,
    )
