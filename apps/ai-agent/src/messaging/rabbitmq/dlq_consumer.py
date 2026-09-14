"""Consumer simples para as DLQs, sem escada de retry.

O :class:`RabbitMqConsumer` normal nao serve aqui: ele republica falhas na fila
de retry e, esgotadas as tentativas, manda para a DLQ. Aplicado a uma DLQ, isso
criaria uma DLQ-da-DLQ — e o retry por bucket nao faz sentido para uma mensagem
que ja falhou definitivamente.

A politica aqui e outra, e mais simples:

- sucesso -> ``ack``, e a mensagem sai da DLQ porque ja esta no catalogo;
- falha   -> ``nack(requeue=True)``, e a mensagem **fica na DLQ**.

A segunda linha e a garantia central da Entrega 5: se a API estiver fora, nada se
perde — as mensagens se acumulam na DLQ e a profundidade da fila dispara o
alerta. O catalogo fica atrasado, nunca incompleto em silencio.

As DLQs nao tem ``x-dead-letter-exchange``, entao um ``nack(requeue=True)``
devolve a mensagem para a propria DLQ, e nao para outro lugar.
"""

from __future__ import annotations

import asyncio
import logging

import aio_pika
from aio_pika.abc import AbstractIncomingMessage

from ..base import BrokerMessage, MessageConsumer, MessageHandler
from .connection import RabbitConnection

logger = logging.getLogger(__name__)

#: Espera antes de devolver a mensagem a fila apos uma falha.
#:
#: Sem ela, um `nack(requeue=True)` reentrega na hora e o consumer entra em loop
#: quente contra uma API que esta fora — queimando CPU e enchendo o log
#: exatamente durante o incidente. Com prefetch baixo, esta pausa e o que
#: transforma o loop em uma tentativa a cada poucos segundos.
REQUEUE_BACKOFF_SECONDS = 5.0


class DlqCatalogConsumer(MessageConsumer):
    """Consome uma DLQ e delega ao handler. Ack so apos sucesso."""

    def __init__(
        self,
        connection: RabbitConnection,
        *,
        queue_name: str,
        routing_key: str,
        prefetch: int = 5,
        requeue_backoff_seconds: float = REQUEUE_BACKOFF_SECONDS,
    ) -> None:
        self._conn = connection
        self._queue_name = queue_name
        self._routing_key = routing_key
        self._prefetch = prefetch
        self._backoff = requeue_backoff_seconds
        self._channel = None
        self._queue = None
        self._tag: str | None = None
        self._running = False

    async def start(self, handler: MessageHandler) -> None:
        # Canal proprio: o prefetch e por canal, e a pausa antes do nack nao
        # pode consumir o orcamento de entrega dos consumers principais.
        channel = await self._conn.dedicated_consume_channel(self._prefetch)

        async def on_message(message: AbstractIncomingMessage) -> None:
            await self._handle(message, handler)

        # O canal so passa a ser da instancia depois que o consumo comecou.
        # Antes, ele era atribuido logo ao abrir: se `get_queue` ou `consume`
        # falhasse, o `bootstrap` engolia a excecao e descartava esta instancia
        # sem nunca chamar `stop()` — e o canal ficava aberto pela vida inteira
        # do processo.
        try:
            queue = await channel.get_queue(self._queue_name, ensure=False)
            tag = await queue.consume(on_message)
        except BaseException:
            await self._close_quietly(channel)
            raise

        self._channel = channel
        self._queue = queue
        self._tag = tag
        self._running = True
        logger.info("Consumer do catalogo ligado em %s", self._queue_name)

    async def _close_quietly(self, channel) -> None:
        if channel is None or channel.is_closed:
            return
        try:
            await channel.close()
        except Exception:  # noqa: BLE001 - a excecao que importa e a original
            logger.debug("Falha ao fechar o canal do catalogo", exc_info=True)

    async def _handle(self, message: AbstractIncomingMessage, handler: MessageHandler) -> None:
        broker_message = BrokerMessage(
            body=message.body,
            routing_key=self._routing_key,
            correlation_id=message.correlation_id,
            headers=dict(message.headers or {}),
        )
        try:
            await handler(broker_message)
        except Exception as exc:  # noqa: BLE001 - a politica e devolver, nao morrer
            logger.warning(
                "Falha ao catalogar mensagem de %s (%s); devolvendo a fila",
                self._queue_name,
                type(exc).__name__,
            )
            # A pausa acontece antes do nack de proposito: com prefetch baixo, ela
            # segura a proxima entrega e evita o loop quente.
            await asyncio.sleep(self._backoff)
            await message.nack(requeue=True)
            return

        await message.ack()

    async def stop(self, drain_timeout: float = 20.0) -> None:
        self._running = False
        if self._queue is not None and self._tag is not None:
            try:
                await self._queue.cancel(self._tag)
            except Exception:  # noqa: BLE001 - encerramento nao deve levantar
                logger.debug("Falha ao cancelar o consumo de %s", self._queue_name, exc_info=True)
        self._tag = None
        self._queue = None

        await self._close_quietly(self._channel)
        self._channel = None

    async def healthy(self) -> bool:
        return self._running
