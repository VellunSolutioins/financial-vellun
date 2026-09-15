"""Driver de mensageria em memória.

Dois usos:

- **testes** — permite exercitar publisher, consumer, retry e DLQ sem Docker.
  O teste chama :meth:`InMemoryBroker.drain` para processar o que está
  enfileirado de forma determinística (sem esperar backoff real);
- **desenvolvimento** — ``MESSAGE_BROKER=inmemory`` roda todo o pipeline em um
  único processo. **Não é durável**: nada sobrevive a restart.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict, deque
from typing import Any

from pydantic import BaseModel

from .base import (
    HEADER_ATTEMPT,
    HEADER_DEFER_COUNT,
    BrokerMessage,
    MessageConsumer,
    MessageHandler,
    MessagePublisher,
    PublishError,
    dispatch,
)
from .contracts import DlqEnvelopeV1

logger = logging.getLogger(__name__)


def sanitize_error(exc: BaseException) -> str:
    """Mensagem de erro truncada — nunca inclui corpo de payload nem segredo."""
    text = str(exc) or type(exc).__name__
    return text[:500]


def build_dlq_envelope(
    message: BrokerMessage, exc: BaseException, permanent: bool, source_queue: str
) -> DlqEnvelopeV1:
    """Monta o envelope da DLQ com o payload original e o erro sanitizado."""
    try:
        payload: Any = json.loads(message.body)
    except (ValueError, UnicodeDecodeError):
        payload = {"raw": message.body.decode("utf-8", errors="replace")[:2000]}
    return DlqEnvelopeV1(
        payload=payload,
        source_queue=source_queue,
        routing_key=message.routing_key,
        attempts=message.attempt + 1,
        error_type=type(exc).__name__,
        error_message=sanitize_error(exc),
        permanent=permanent,
        # Vem do header `x-first-failed-at`, propagado a cada retry. Sem copiar
        # aqui, o envelope saia sempre com `firstFailedAt` nulo e o operador
        # perdia a unica informacao que distingue "falhou agora" de "vem
        # falhando ha duas horas" — `failedAt` e sempre a ultima tentativa.
        first_failed_at=message.first_failed_at,
        correlation_id=message.correlation_id,
    )


class InMemoryBroker:
    """Estado compartilhado entre o publisher e os consumers em memória."""

    def __init__(self, max_retries: int = 3) -> None:
        self.max_retries = max_retries
        self.queues: dict[str, deque[BrokerMessage]] = defaultdict(deque)
        self.published: dict[str, list[BrokerMessage]] = defaultdict(list)
        self.dlq: list[DlqEnvelopeV1] = []
        self.acked: list[BrokerMessage] = []
        self.retried: list[BrokerMessage] = []
        # Quando definido, a próxima publicação levanta esta exceção (teste de 503).
        self.fail_publish: BaseException | None = None
        self._handlers: dict[str, MessageHandler] = {}

    async def publish_body(
        self,
        routing_key: str,
        body: bytes,
        *,
        correlation_id: str | None = None,
        headers: dict[str, Any] | None = None,
        attempt: int = 0,
    ) -> None:
        if self.fail_publish is not None:
            raise self.fail_publish
        message = BrokerMessage(
            body=body,
            routing_key=routing_key,
            attempt=attempt,
            correlation_id=correlation_id,
            headers=dict(headers or {}),
        )
        self.queues[routing_key].append(message)
        self.published[routing_key].append(message)

    def register(self, routing_key: str, handler: MessageHandler) -> None:
        self._handlers[routing_key] = handler

    def unregister(self, routing_key: str) -> None:
        self._handlers.pop(routing_key, None)

    def pending(self) -> int:
        return sum(len(self.queues[key]) for key in self._handlers)

    async def drain(self, max_cycles: int = 500) -> None:
        """Processa tudo que está enfileirado para handlers registrados."""
        cycles = 0
        while self.pending() and cycles < max_cycles:
            cycles += 1
            for routing_key, handler in list(self._handlers.items()):
                queue = self.queues[routing_key]
                if not queue:
                    continue
                message = queue.popleft()
                await self._dispatch(message, handler)
        if cycles >= max_cycles:
            logger.warning("drain atingiu o limite de ciclos; possível loop de retry")

    async def _dispatch(self, message: BrokerMessage, handler: MessageHandler) -> None:
        outcome = await dispatch(
            message,
            handler,
            max_retries=self.max_retries,
            on_retry=self._on_retry,
            on_dlq=self._on_dlq,
        )
        if outcome == "ack":
            self.acked.append(message)

    async def _on_retry(
        self, message: BrokerMessage, exc: BaseException, count_attempt: bool = True
    ) -> None:
        # Sem espera real: o backoff é irrelevante em memória e travaria os testes.
        attempt = message.attempt + 1 if count_attempt else message.attempt
        headers = {**message.headers, HEADER_ATTEMPT: attempt}
        if not count_attempt:
            headers[HEADER_DEFER_COUNT] = int(headers.get(HEADER_DEFER_COUNT, 0)) + 1
        retried = BrokerMessage(
            body=message.body,
            routing_key=message.routing_key,
            attempt=attempt,
            correlation_id=message.correlation_id,
            headers=headers,
        )
        self.retried.append(retried)
        self.queues[message.routing_key].append(retried)

    async def _on_dlq(
        self, message: BrokerMessage, exc: BaseException, permanent: bool
    ) -> None:
        self.dlq.append(build_dlq_envelope(message, exc, permanent, message.routing_key))


class InMemoryPublisher(MessagePublisher):
    def __init__(self, broker: InMemoryBroker) -> None:
        self._broker = broker
        self._started = False

    async def start(self) -> None:
        self._started = True

    async def stop(self) -> None:
        self._started = False

    async def publish(
        self,
        routing_key: str,
        message: BaseModel,
        *,
        correlation_id: str | None = None,
        headers: dict[str, Any] | None = None,
    ) -> None:
        try:
            await self._broker.publish_body(
                routing_key,
                message.model_dump_json(by_alias=True).encode(),
                correlation_id=correlation_id,
                headers=headers,
            )
        except Exception as exc:  # noqa: BLE001
            raise PublishError(str(exc)) from exc

    async def healthy(self) -> bool:
        return self._started and self._broker.fail_publish is None


class InMemoryConsumer(MessageConsumer):
    """Consumer em memória; com ``auto_dispatch`` roda um loop de fundo."""

    def __init__(
        self, broker: InMemoryBroker, routing_key: str, *, auto_dispatch: bool = False
    ) -> None:
        self._broker = broker
        self._routing_key = routing_key
        self._auto = auto_dispatch
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self, handler: MessageHandler) -> None:
        self._broker.register(self._routing_key, handler)
        self._running = True
        if self._auto:
            self._task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        while self._running:
            try:
                await self._broker.drain()
            except Exception:  # noqa: BLE001 — o loop nunca deve morrer
                logger.exception("Erro no loop do consumer em memória")
            await asyncio.sleep(0.05)

    async def stop(self, drain_timeout: float = 20.0) -> None:
        self._running = False
        self._broker.unregister(self._routing_key)
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def healthy(self) -> bool:
        return self._running
