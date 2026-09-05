"""Ciclo de vida do pipeline de mensageria.

Um único objeto (``pipeline``) monta e desmonta publisher, consumers e worker de
agrupamento. É usado tanto pelo ``lifespan`` da API quanto pelo entrypoint
``python -m src.worker``.

Shutdown gracioso, nesta ordem:

1. o worker de agrupamento para de consolidar novos grupos;
2. os consumers param de receber, aguardam o que está em voo e devolvem
   (``nack requeue``) o que não terminou dentro de ``SHUTDOWN_DRAIN_SECONDS``;
3. conexões HTTP, Redis e broker são fechadas.

Nenhuma mensagem já confirmada pelo broker se perde num deploy.
"""

from __future__ import annotations

import logging

from .config import settings
from .grouping import GroupFlusherWorker, get_group_store
from .messaging.base import ROUTE_INBOUND, ROUTE_PROCESSING, MessageConsumer, MessagePublisher
from .messaging.factory import create_consumer, create_publisher

logger = logging.getLogger(__name__)


class Pipeline:
    def __init__(self) -> None:
        self.publisher: MessagePublisher | None = None
        self.flusher: GroupFlusherWorker | None = None
        self._broker_consumers: list[MessageConsumer] = []
        self._consumers_running = False

    # ── Inicialização ───────────────────────────────────────────────────────
    async def start_publisher(self) -> None:
        """Conecta ao broker e declara a topologia (idempotente)."""
        if self.publisher is not None:
            return
        publisher = create_publisher()
        await publisher.start()
        self.publisher = publisher
        logger.info("Publisher de mensageria pronto")

    async def start_consumers(self) -> None:
        """Sobe os dois consumers e o worker de agrupamento."""
        if self._consumers_running:
            return
        await self.start_publisher()
        assert self.publisher is not None

        from .consumers import InboundMessageConsumer, MessageProcessingConsumer

        inbound = InboundMessageConsumer(self.publisher)
        processing = MessageProcessingConsumer()

        inbound_consumer = create_consumer(settings.rabbitmq_inbound_queue, ROUTE_INBOUND)
        await inbound_consumer.start(inbound.handle)

        processing_consumer = create_consumer(
            settings.rabbitmq_processing_queue, ROUTE_PROCESSING
        )
        await processing_consumer.start(processing.handle)

        self._broker_consumers = [inbound_consumer, processing_consumer]

        self.flusher = GroupFlusherWorker(get_group_store(), self.publisher)
        self.flusher.start()

        self._consumers_running = True
        logger.info("Consumers do pipeline WhatsApp iniciados")

    # ── Encerramento ────────────────────────────────────────────────────────
    async def stop(self) -> None:
        if self.flusher is not None:
            await self.flusher.stop()
            self.flusher = None

        for consumer in self._broker_consumers:
            await consumer.stop(drain_timeout=settings.shutdown_drain_seconds)
        self._broker_consumers = []
        self._consumers_running = False

        if self.publisher is not None:
            await self.publisher.stop()
            self.publisher = None

        from .services.api_client import api_client
        from .services.redis_client import redis_provider

        await api_client.aclose()
        await redis_provider.close()
        logger.info("Pipeline encerrado")

    # ── Saúde ───────────────────────────────────────────────────────────────
    def require_publisher(self) -> MessagePublisher:
        """Publisher pronto, ou erro — o webhook traduz isso em ``503``."""
        if self.publisher is None:
            raise RuntimeError("publisher de mensageria não inicializado")
        return self.publisher

    async def readiness(self) -> tuple[bool, dict]:
        """Readiness: só está pronto se puder publicar (e consumir, quando aplicável)."""
        can_publish = self.publisher is not None and await self.publisher.healthy()

        consumers_ok = True
        if self._consumers_running:
            for consumer in self._broker_consumers:
                consumers_ok = consumers_ok and await consumer.healthy()

        redis_ok = True
        if _uses_redis():
            from .services.redis_client import redis_provider

            redis_ok = await redis_provider.ping()

        details = {
            "broker": "up" if can_publish else "down",
            "consumers": ("up" if consumers_ok else "down")
            if self._consumers_running
            else "disabled",
            "redis": ("up" if redis_ok else "down") if _uses_redis() else "disabled",
        }
        return (can_publish and consumers_ok and redis_ok), details


def _uses_redis() -> bool:
    return (settings.group_store_backend or "redis").strip().lower() != "memory"


pipeline = Pipeline()
