"""Declaração idempotente de exchanges e filas.

Topologia por fila principal (ex.: ``whatsapp.inbound.v1``):

- ``whatsapp.x`` (direct) → fila principal, routing key ``inbound``;
- ``whatsapp.inbound.retry.{N}s`` — TTL fixo e dead-letter de volta à principal;
- ``whatsapp.inbound.dlq`` — ligada a ``whatsapp.dlx``.

Tudo declarado como ``durable``; as mensagens são publicadas como persistentes.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

import aio_pika
from aio_pika.abc import AbstractRobustChannel

from ..names import (
    EXCHANGE_DLX,
    EXCHANGE_MAIN,
    EXCHANGE_RETRY,
    all_retry_queues,
    dlq_queue,
    dlq_routing_key,
    retry_routing_key,
)

logger = logging.getLogger(__name__)


async def declare_topology(
    channel: AbstractRobustChannel, queues: Sequence[tuple[str, str]]
) -> None:
    """Declara exchanges, filas principais, filas de retry e DLQs.

    ``queues`` é uma sequência de ``(nome_da_fila, routing_key)``.
    """
    main = await channel.declare_exchange(
        EXCHANGE_MAIN, aio_pika.ExchangeType.DIRECT, durable=True
    )
    retry = await channel.declare_exchange(
        EXCHANGE_RETRY, aio_pika.ExchangeType.DIRECT, durable=True
    )
    dlx = await channel.declare_exchange(
        EXCHANGE_DLX, aio_pika.ExchangeType.DIRECT, durable=True
    )

    for queue_name, routing_key in queues:
        dlq_name = dlq_queue(queue_name)
        dlq_rk = dlq_routing_key(routing_key)

        dlq = await channel.declare_queue(dlq_name, durable=True)
        await dlq.bind(dlx, routing_key=dlq_rk)

        # A DLX da fila principal cobre rejeições explícitas e mensagens expiradas.
        queue = await channel.declare_queue(
            queue_name,
            durable=True,
            arguments={
                "x-dead-letter-exchange": EXCHANGE_DLX,
                "x-dead-letter-routing-key": dlq_rk,
            },
        )
        await queue.bind(main, routing_key=routing_key)

        for retry_name, bucket_seconds in all_retry_queues(queue_name):
            retry_q = await channel.declare_queue(
                retry_name,
                durable=True,
                arguments={
                    "x-message-ttl": bucket_seconds * 1000,
                    # Expirado, volta para a exchange principal na fila de origem.
                    "x-dead-letter-exchange": EXCHANGE_MAIN,
                    "x-dead-letter-routing-key": routing_key,
                },
            )
            await retry_q.bind(retry, routing_key=retry_routing_key(routing_key, bucket_seconds))

    logger.info("Topologia do RabbitMQ declarada (%d fila(s) principal(is))", len(queues))
