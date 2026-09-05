"""Agrupamento distribuido em Redis.

Chaves:

- ``group:{phone}``       lista (RPUSH) das mensagens aguardando consolidacao;
- ``group:first:{phone}`` epoch da primeira mensagem do grupo (teto de idade);
- ``group:due``           sorted-set telefone -> vencimento do debounce;
- ``group:lock:{phone}``  lock distribuido durante a consolidacao.

O vencimento e ``min(agora + debounce, primeira + idade_maxima)``. O teto de
idade e calculado a partir da **primeira** mensagem do grupo, entao um fluxo
continuo de mensagens nao adia o flush indefinidamente.
"""

from __future__ import annotations

import logging
import time

from ..config import settings
from ..services.redis_client import RedisProvider, redis_provider
from .base import GroupEntry, GroupStore

logger = logging.getLogger(__name__)

DUE_KEY = "group:due"


def _buffer_key(phone: str) -> str:
    return f"group:{phone}"


def _first_key(phone: str) -> str:
    return f"group:first:{phone}"


def _lock_key(phone: str) -> str:
    return f"group:lock:{phone}"


class RedisGroupStore(GroupStore):
    def __init__(self, provider: RedisProvider | None = None) -> None:
        self._provider = provider or redis_provider

    async def append(self, phone: str, entry: GroupEntry) -> int:
        client = await self._provider.client()
        now = time.time()

        length = await client.rpush(_buffer_key(phone), entry.to_json())
        # Marca o inicio do grupo apenas na primeira mensagem.
        await client.set(_first_key(phone), now, nx=True)
        first = await client.get(_first_key(phone))
        first_at = float(first) if first is not None else now

        max_due = first_at + settings.message_buffer_max_age_seconds
        if length >= settings.message_buffer_max_messages:
            due = now  # flush imediato ao atingir o limite de mensagens
        else:
            due = min(now + settings.message_buffer_debounce_seconds, max_due)

        await client.zadd(DUE_KEY, {phone: due})
        return int(length)

    async def due_phones(self) -> list[str]:
        client = await self._provider.client()
        return list(await client.zrangebyscore(DUE_KEY, "-inf", time.time()))

    async def peek(self, phone: str) -> list[GroupEntry]:
        client = await self._provider.client()
        raw = await client.lrange(_buffer_key(phone), 0, -1)
        return [GroupEntry.from_json(item) for item in raw]

    async def clear(self, phone: str) -> None:
        client = await self._provider.client()
        async with client.pipeline(transaction=True) as pipe:
            pipe.delete(_buffer_key(phone))
            pipe.delete(_first_key(phone))
            pipe.zrem(DUE_KEY, phone)
            await pipe.execute()

    async def acquire_lock(self, phone: str, ttl_seconds: int) -> bool:
        client = await self._provider.client()
        return bool(
            await client.set(_lock_key(phone), "1", nx=True, px=ttl_seconds * 1000)
        )

    async def release_lock(self, phone: str) -> None:
        client = await self._provider.client()
        await client.delete(_lock_key(phone))
