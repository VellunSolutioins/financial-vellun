"""Locks e marcadores distribuidos usados pelo consumer de processamento.

Duas primitivas, ambas com TTL para nunca travar para sempre:

- ``acquire``/``extend``/``release`` — lock por telefone **com dono**, garantindo
  que dois workers nao processem o mesmo numero ao mesmo tempo (ordenacao
  logica). ``acquire`` devolve um token; so quem o tem renova e libera;
- ``mark``/``exists``/``forget`` — marcador de job ja concluido, para que uma
  reentrega apos o ack nao reprocesse;
- ``put``/``get`` — valor curto com TTL. Guarda a resposta ja calculada de um
  job, para que o retry de uma **entrega** que falhou reenvie o texto em vez de
  reprocessar o job inteiro.

O backend segue ``GROUP_STORE_BACKEND`` (redis em producao, memory em teste).
"""

from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod

from ..config import settings
from . import locks
from .redis_client import RedisProvider, redis_provider

logger = logging.getLogger(__name__)


class StateStore(ABC):
    @abstractmethod
    async def acquire(self, key: str, ttl_seconds: int) -> str | None:
        """Adquire o lock. Devolve o token do dono, ou ``None`` se outro detem."""

    @abstractmethod
    async def extend(self, key: str, token: str, ttl_seconds: int) -> bool:
        """Renova o TTL. ``False`` quando o lock ja nao pertence ao token."""

    @abstractmethod
    async def release(self, key: str, token: str) -> bool:
        """Libera **so se ainda for o dono**. ``False`` quando ja nao era."""

    @abstractmethod
    async def mark(self, key: str, ttl_seconds: int) -> None: ...

    @abstractmethod
    async def exists(self, key: str) -> bool: ...

    @abstractmethod
    async def forget(self, key: str) -> None:
        """Remove um marcador ou valor. Nao serve para lock: lock se libera com o token."""

    @abstractmethod
    async def put(self, key: str, value: str, ttl_seconds: int) -> None: ...

    @abstractmethod
    async def get(self, key: str) -> str | None:
        """Valor gravado por ``put``, ou ``None`` se ausente ou expirado."""


class InMemoryStateStore(StateStore):
    def __init__(self) -> None:
        self._entries: dict[str, float] = {}
        self._values: dict[str, str] = {}
        self._locks = locks.InMemoryLocks()

    def _alive(self, key: str) -> bool:
        expires = self._entries.get(key)
        if expires is None:
            return False
        if expires <= time.time():
            self._entries.pop(key, None)
            self._values.pop(key, None)
            return False
        return True

    async def acquire(self, key: str, ttl_seconds: int) -> str | None:
        return self._locks.acquire(key, ttl_seconds)

    async def extend(self, key: str, token: str, ttl_seconds: int) -> bool:
        return self._locks.extend(key, token, ttl_seconds)

    async def release(self, key: str, token: str) -> bool:
        return self._locks.release(key, token)

    async def mark(self, key: str, ttl_seconds: int) -> None:
        self._entries[key] = time.time() + ttl_seconds

    async def exists(self, key: str) -> bool:
        return self._alive(key)

    async def forget(self, key: str) -> None:
        self._entries.pop(key, None)
        self._values.pop(key, None)

    async def put(self, key: str, value: str, ttl_seconds: int) -> None:
        self._entries[key] = time.time() + ttl_seconds
        self._values[key] = value

    async def get(self, key: str) -> str | None:
        return self._values.get(key) if self._alive(key) else None

    def expire_lock_now(self, key: str) -> None:
        """Auxiliar de teste: simula o TTL do lock vencendo."""
        self._locks.expire_now(key)


class RedisStateStore(StateStore):
    def __init__(self, provider: RedisProvider | None = None) -> None:
        self._provider = provider or redis_provider

    async def acquire(self, key: str, ttl_seconds: int) -> str | None:
        client = await self._provider.client()
        return await locks.redis_acquire(client, key, ttl_seconds)

    async def extend(self, key: str, token: str, ttl_seconds: int) -> bool:
        client = await self._provider.client()
        return await locks.redis_extend(client, key, token, ttl_seconds)

    async def release(self, key: str, token: str) -> bool:
        client = await self._provider.client()
        return await locks.redis_release(client, key, token)

    async def mark(self, key: str, ttl_seconds: int) -> None:
        client = await self._provider.client()
        await client.set(key, "1", ex=ttl_seconds)

    async def exists(self, key: str) -> bool:
        client = await self._provider.client()
        return bool(await client.exists(key))

    async def forget(self, key: str) -> None:
        client = await self._provider.client()
        await client.delete(key)

    async def put(self, key: str, value: str, ttl_seconds: int) -> None:
        client = await self._provider.client()
        await client.set(key, value, ex=ttl_seconds)

    async def get(self, key: str) -> str | None:
        client = await self._provider.client()
        return await client.get(key)


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
