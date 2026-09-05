"""Seleção do driver de mensageria por configuração (``MESSAGE_BROKER``)."""

from __future__ import annotations

import logging

from ..config import settings
from .base import ROUTE_INBOUND, ROUTE_PROCESSING, MessageConsumer, MessagePublisher
from .inmemory import InMemoryBroker, InMemoryConsumer, InMemoryPublisher

logger = logging.getLogger(__name__)

#: Broker em memória compartilhado por publisher e consumers no modo inmemory.
_inmemory_broker: InMemoryBroker | None = None


def queue_definitions() -> list[tuple[str, str]]:
    """Filas principais do pipeline: ``(nome, routing_key)``."""
    return [
        (settings.rabbitmq_inbound_queue, ROUTE_INBOUND),
        (settings.rabbitmq_processing_queue, ROUTE_PROCESSING),
    ]


def inmemory_broker() -> InMemoryBroker:
    global _inmemory_broker
    if _inmemory_broker is None:
        _inmemory_broker = InMemoryBroker(max_retries=settings.message_max_retries)
    return _inmemory_broker


def reset_inmemory_broker() -> None:
    """Zera o broker em memória (usado entre testes)."""
    global _inmemory_broker
    _inmemory_broker = None


def _driver() -> str:
    return (settings.message_broker or "rabbitmq").strip().lower()


def create_publisher() -> MessagePublisher:
    if _driver() == "inmemory":
        logger.info("Mensageria usando driver em memoria")
        return InMemoryPublisher(inmemory_broker())

    from .rabbitmq import RabbitMqPublisher

    logger.info("Mensageria usando RabbitMQ")
    return RabbitMqPublisher(_rabbit_connection(), queue_definitions())


def create_consumer(queue_name: str, routing_key: str) -> MessageConsumer:
    if _driver() == "inmemory":
        return InMemoryConsumer(inmemory_broker(), routing_key, auto_dispatch=True)

    from .rabbitmq import RabbitMqConsumer

    concurrency = (
        settings.inbound_consumer_concurrency
        if routing_key == ROUTE_INBOUND
        else settings.processing_consumer_concurrency
    )
    return RabbitMqConsumer(
        _rabbit_connection(),
        queue_name=queue_name,
        routing_key=routing_key,
        concurrency=concurrency,
        max_retries=settings.message_max_retries,
        retry_base_seconds=settings.message_retry_base_seconds,
        retry_max_seconds=settings.message_retry_max_seconds,
    )


_rabbit_conn = None


def _rabbit_connection():
    """Conexao unica reaproveitada por publisher e consumers."""
    global _rabbit_conn
    if _rabbit_conn is None:
        from .rabbitmq import RabbitConnection

        _rabbit_conn = RabbitConnection(
            settings.rabbitmq_url, prefetch=settings.rabbitmq_prefetch
        )
    return _rabbit_conn
