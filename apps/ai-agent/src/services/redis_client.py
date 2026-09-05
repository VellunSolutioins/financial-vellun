"""Conexao Redis compartilhada (agrupamento, locks e estado de conversa).

Um unico pool para todo o processo, criado sob demanda e fechado no shutdown.
"""

from __future__ import annotations

import logging

from ..config import settings

logger = logging.getLogger(__name__)


class RedisProvider:
    def __init__(self, url: str | None = None) -> None:
        self._url = url or settings.redis_url
        self._client = None

    async def client(self):
        if self._client is None:
            from redis import asyncio as aioredis

            self._client = aioredis.from_url(
                self._url, encoding="utf-8", decode_responses=True
            )
        return self._client

    async def ping(self) -> bool:
        try:
            client = await self.client()
            return bool(await client.ping())
        except Exception:  # noqa: BLE001 - readiness nao pode levantar
            logger.warning("Redis indisponivel", exc_info=True)
            return False

    async def close(self) -> None:
        if self._client is not None:
            try:
                await self._client.aclose()
            except Exception:  # noqa: BLE001
                logger.debug("Erro ao fechar o Redis", exc_info=True)
            self._client = None


redis_provider = RedisProvider()
