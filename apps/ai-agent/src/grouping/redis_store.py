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

from ..services import locks
from ..services.redis_client import RedisProvider, redis_provider
from .base import AppendResult, GroupEntry, GroupStore, due_at as _due_at

logger = logging.getLogger(__name__)

DUE_KEY = "group:due"

#: RPUSH condicional: só empilha se nenhuma entrada do grupo carregar o mesmo
#: ``provider_message_id``. Precisa ser um script porque ler a lista e empilhar
#: em dois comandos deixaria janela para duas entregas concorrentes da mesma
#: mensagem entrarem as duas. Devolve ``{tamanho, adicionou}``.
APPEND_DEDUPED_LUA = """
local key = KEYS[1]
local entry = ARGV[1]
local provider_id = ARGV[2]

if provider_id ~= '' then
  local items = redis.call('LRANGE', key, 0, -1)
  for index = 1, #items do
    local ok, decoded = pcall(cjson.decode, items[index])
    if ok and decoded['provider_message_id'] == provider_id then
      return {#items, 0}
    end
  end
end

return {redis.call('RPUSH', key, entry), 1}
"""


def _buffer_key(phone: str) -> str:
    return f"group:{phone}"


def _first_key(phone: str) -> str:
    return f"group:first:{phone}"


def _lock_key(phone: str) -> str:
    return f"group:lock:{phone}"


class RedisGroupStore(GroupStore):
    def __init__(self, provider: RedisProvider | None = None) -> None:
        self._provider = provider or redis_provider

    async def append(self, phone: str, entry: GroupEntry) -> AppendResult:
        client = await self._provider.client()
        now = time.time()

        length, added = await client.eval(
            APPEND_DEDUPED_LUA,
            1,
            _buffer_key(phone),
            entry.to_json(),
            entry.provider_message_id or "",
        )
        length = int(length)
        if not int(added):
            # Ja estava no grupo: nada a reagendar, o vencimento vigente vale.
            return AppendResult(length=length, added=False)

        # Marca o inicio do grupo apenas na primeira mensagem.
        await client.set(_first_key(phone), now, nx=True)
        first = await client.get(_first_key(phone))
        first_at = float(first) if first is not None else now

        await client.zadd(DUE_KEY, {phone: _due_at(now, first_at, length)})
        return AppendResult(length=length, added=True)

    async def due_phones(self) -> list[str]:
        client = await self._provider.client()
        return list(await client.zrangebyscore(DUE_KEY, "-inf", time.time()))

    async def peek(self, phone: str, limit: int | None = None) -> list[GroupEntry]:
        client = await self._provider.client()
        fim = -1 if limit is None else limit - 1
        raw = await client.lrange(_buffer_key(phone), 0, fim)
        return [GroupEntry.from_json(item) for item in raw]

    async def consume(self, phone: str, count: int) -> int:
        client = await self._provider.client()
        now = time.time()

        async with client.pipeline(transaction=True) as pipe:
            pipe.ltrim(_buffer_key(phone), count, -1)
            pipe.llen(_buffer_key(phone))
            _, restantes = await pipe.execute()

        restantes = int(restantes)
        if restantes <= 0:
            await self.clear(phone)
            return 0

        # O excedente vira um grupo novo: o teto de idade passa a contar daqui.
        await client.set(_first_key(phone), now)
        await client.zadd(DUE_KEY, {phone: _due_at(now, now, restantes)})
        return restantes

    async def clear(self, phone: str) -> None:
        client = await self._provider.client()
        async with client.pipeline(transaction=True) as pipe:
            pipe.delete(_buffer_key(phone))
            pipe.delete(_first_key(phone))
            pipe.zrem(DUE_KEY, phone)
            await pipe.execute()

    # O lock usa a mesma implementacao do `StateStore` (`services/locks.py`),
    # em vez de reimplementar: antes, as duas copias tinham o mesmo defeito de
    # liberar sem checar o dono.
    async def acquire_lock(self, phone: str, ttl_seconds: int) -> str | None:
        client = await self._provider.client()
        return await locks.redis_acquire(client, _lock_key(phone), ttl_seconds)

    async def extend_lock(self, phone: str, token: str, ttl_seconds: int) -> bool:
        client = await self._provider.client()
        return await locks.redis_extend(client, _lock_key(phone), token, ttl_seconds)

    async def release_lock(self, phone: str, token: str) -> bool:
        client = await self._provider.client()
        return await locks.redis_release(client, _lock_key(phone), token)
