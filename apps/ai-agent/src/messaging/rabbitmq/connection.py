"""Conexão e canais reutilizáveis do RabbitMQ.

- ``connect_robust`` reconecta sozinho quando o broker cai;
- a conexão inicial tem backoff exponencial próprio, para o processo não morrer
  ao subir antes do broker;
- canais separados para publicar (com *publisher confirms*) e consumir (com
  ``prefetch``), evitando que um bloqueio de consumo atrase publicações.
"""

from __future__ import annotations

import asyncio
import logging

import aio_pika
from aio_pika.abc import AbstractRobustChannel, AbstractRobustConnection

logger = logging.getLogger(__name__)


class RabbitConnection:
    def __init__(self, url: str, prefetch: int = 10) -> None:
        self._url = url
        self._prefetch = prefetch
        self._connection: AbstractRobustConnection | None = None
        self._publish_channel: AbstractRobustChannel | None = None
        self._consume_channel: AbstractRobustChannel | None = None
        self._lock = asyncio.Lock()

    async def connect(self, *, max_attempts: int = 6, base_delay: float = 0.5) -> None:
        """Conecta com backoff exponencial. Levanta a última exceção se falhar."""
        async with self._lock:
            if self._connection is not None and not self._connection.is_closed:
                return
            last_error: Exception | None = None
            for attempt in range(max_attempts):
                try:
                    self._connection = await aio_pika.connect_robust(self._url)
                    logger.info("Conectado ao RabbitMQ")
                    return
                except Exception as exc:  # noqa: BLE001 — retentar até o broker subir
                    last_error = exc
                    delay = min(base_delay * (2**attempt), 10.0)
                    logger.warning(
                        "Falha ao conectar no RabbitMQ (tentativa %d/%d); nova tentativa em %.1fs",
                        attempt + 1,
                        max_attempts,
                        delay,
                    )
                    await asyncio.sleep(delay)
            raise RuntimeError(f"Não foi possível conectar ao RabbitMQ: {last_error}")

    async def publish_channel(self) -> AbstractRobustChannel:
        await self.connect()
        if self._publish_channel is None or self._publish_channel.is_closed:
            assert self._connection is not None
            self._publish_channel = await self._connection.channel(publisher_confirms=True)
        return self._publish_channel

    async def consume_channel(self) -> AbstractRobustChannel:
        await self.connect()
        if self._consume_channel is None or self._consume_channel.is_closed:
            assert self._connection is not None
            self._consume_channel = await self._connection.channel()
            await self._consume_channel.set_qos(prefetch_count=self._prefetch)
        return self._consume_channel

    async def dedicated_consume_channel(self, prefetch: int) -> AbstractRobustChannel:
        """Canal de consumo **proprio**, com prefetch independente.

        O `consume_channel()` acima e compartilhado, e o prefetch e por canal.
        Um consumer que segura entregas — o do catalogo espera antes de devolver
        a mensagem a fila quando a API esta fora — consumiria o orcamento de
        prefetch dos consumers principais, atrasando o pipeline justamente
        durante um incidente. Canal separado isola isso.

        Nao e memorizado: quem pede e dono do canal e o fecha no proprio stop.
        """
        await self.connect()
        assert self._connection is not None
        channel = await self._connection.channel()
        await channel.set_qos(prefetch_count=prefetch)
        return channel

    def is_connected(self) -> bool:
        return self._connection is not None and not self._connection.is_closed

    async def close(self) -> None:
        for channel in (self._publish_channel, self._consume_channel):
            if channel is not None and not channel.is_closed:
                try:
                    await channel.close()
                except Exception:  # noqa: BLE001 — shutdown não deve falhar
                    logger.debug("Erro ao fechar canal do RabbitMQ", exc_info=True)
        self._publish_channel = None
        self._consume_channel = None
        if self._connection is not None and not self._connection.is_closed:
            await self._connection.close()
        self._connection = None
