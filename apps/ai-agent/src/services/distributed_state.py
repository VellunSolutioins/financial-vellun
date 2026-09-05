"""Locks e marcadores distribuidos usados pelo consumer de processamento.

Duas primitivas, ambas com TTL para nunca travar para sempre:

- ``acquire``/``release`` — lock por telefone, garantindo que dois workers nao
  processem o mesmo numero ao mesmo tempo (ordenacao logica);
- ``mark``/``exists`` — marcador de job ja concluido, para que uma reentrega
  apos o ack nao reprocesse.

O backend segue ``GROUP_STORE_BACKEND`` (redis em producao, memory em teste).
"""

from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod

from ..config import settings
from .redis_client import RedisProvider, redis_provider

logger = logging.getLogger(__name__)


class StateStore(ABC):
    @abstractmethod
    async def acquire(self, key: str, ttl_seconds: int) -> bool: ...

    @abstractmethod
    async def release(self, key: str) -> None: ...

    @abstractmethod
    async def mark(self, key: str, ttl_seconds: int) -> None: ...

    @abstractmethod
    async def exists(self, key: str) -> bool: ...


class InMemoryStateStore(StateStore):
    def __init__(self) -> None:
        self._entries: dict[str, float] = {}

    def _alive(self, key: str) -> bool:
        expires = self._entries.get(key)
        if expires is None:
            return False
        if expires <= time.time():
            self._entries.pop(key, None)
            return False
        return True

    async def acquire(self, key: str, ttl_seconds: int) -> bool:
        if self._alive(key):
            return False
        self._entries[key] = time.time() + ttl_seconds
        return True

    async def release(self, key: str) -> None:
        self._entries.pop(key, None)

    async def mark(self, key: str, ttl_seconds: int) -> None:
        self._entries[key] = time.time() + ttl_seconds

    async def exists(self, key: str) -> bool:
        return self._alive(key)


class RedisStateStore(StateStore):
    def __init__(self, provider: RedisProvider | None = None) -> None:
        self._provider = provider or redis_provider

    async def acquire(self, key: str, ttl_seconds: int) -> bool:
        client = await self._provider.client()
        return bool(await client.set(key, "1", nx=True, px=ttl_seconds * 1000))

    async def release(self, key: str) -> None:
        client = await self._provider.client()
        await client.delete(key)

    async def mark(self, key: str, ttl_seconds: int) -> None:
        client = await self._provider.client()
        await client.set(key, "1", ex=ttl_seconds)

    async def exists(self, key: str) -> bool:
        client = await self._provider.client()
        return bool(await client.exists(key))


_store: StateStore | None = None


def get_state_store() -> StateStore:
    global _store
    if _store is None:
        backend = (settings.group_store_backend or "redis").strip().lower()
        if backend == "memory":
            logger.info("Estado distribuido em memoria")
            _store = InMemoryStateStore()
        else:
            logger.info("Estado distribuido no Redis")
            _store = RedisStateStore()
    return _store


def set_state_store(store: StateStore | None) -> None:
    """Injeta um store (testes) ou zera o singleton."""
    global _store
    _store = store
