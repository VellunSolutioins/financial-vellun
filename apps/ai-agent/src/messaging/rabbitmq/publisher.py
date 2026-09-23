"""Publisher RabbitMQ com confirmação obrigatória.

``publish`` só retorna depois do *publisher confirm* do broker. Qualquer falha
vira :class:`PublishError`, que o webhook traduz em ``503``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import aio_pika
from pydantic import BaseModel

from ..base import MessagePublisher, PublishError
from ..names import EXCHANGE_MAIN
from .connection import RabbitConnection
from .topology import declare_topology

logger = logging.getLogger(__name__)


class RabbitMqPublisher(MessagePublisher):
    def __init__(
        self, connection: RabbitConnection, queues: list[tuple[str, str]]
    ) -> None:
        self._conn = connection
        self._queues = queues

    async def start(self) -> None:
        channel = await self._conn.publish_channel()
        await declare_topology(channel, self._queues)

    async def stop(self) -> None:
        await self._conn.close()

    async def publish(
        self,
        routing_key: str,
        message: BaseModel,
        *,
        correlation_id: str | None = None,
        headers: dict[str, Any] | None = None,
    ) -> None:
        body = message.model_dump_json(by_alias=True).encode()
        try:
            channel = await self._conn.publish_channel()
            exchange = await channel.get_exchange(EXCHANGE_MAIN, ensure=False)
            await exchange.publish(
                aio_pika.Message(
                    body=body,
                    content_type="application/json",
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    correlation_id=correlation_id,
                    headers=headers or {},
                    # Propriedade AMQP `timestamp`. É o que alimenta
                    # `rabbitmq_detailed_queue_head_message_timestamp`, e com
                    # ele o alerta de **idade da mensagem mais antiga** — a
                    # pergunta do SLO ("há quanto tempo alguém está sem
                    # resposta?"), que profundidade de fila não responde: uma
                    # fila curta e parada não passa de limiar nenhum.
                    timestamp=datetime.now(timezone.utc),
                ),
                routing_key=routing_key,
            )
        except Exception as exc:  # noqa: BLE001 — sem confirm, não podemos aceitar
            logger.error("Falha ao publicar em %s: %s", routing_key, type(exc).__name__)
            raise PublishError(str(exc)) from exc

    async def healthy(self) -> bool:
        if not self._conn.is_connected():
            return False
        try:
            channel = await self._conn.publish_channel()
            return not channel.is_closed
        except Exception:  # noqa: BLE001
            return False
