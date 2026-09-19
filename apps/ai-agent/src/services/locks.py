"""Lock distribuido **com dono**, compartilhado pelos stores de estado e de agrupamento.

Quem adquire recebe um token, gravado como valor da chave. Liberar e renovar so
funcionam com o token certo, e a comparacao acontece **dentro do Redis**, num
script Lua — ler, comparar e apagar em tres comandos separados deixaria uma
janela entre a leitura e o `DEL`.

O defeito que isso corrige: `release` era um `DELETE` incondicional. Se o
processamento passasse do TTL, outro worker adquiria o lock; quando o primeiro
terminava, apagava o lock que agora era do segundo — e um terceiro podia entrar
enquanto o segundo ainda processava. Era exatamente a ordenacao por telefone que
o lock existe para garantir.

A implementacao em memoria segue as mesmas regras, para que os testes afirmem o
comportamento real e nao um dublê mais permissivo.
"""

from __future__ import annotations

import secrets
import time

#: Apaga a chave so se o valor for o token de quem pede.
_LIBERAR_SE_DONO = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""

#: Renova o TTL so se o valor for o token de quem pede.
_RENOVAR_SE_DONO = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
"""


def novo_token() -> str:
    return secrets.token_hex(16)


async def redis_acquire(client, key: str, ttl_seconds: int) -> str | None:
    """Adquire o lock. Devolve o token, ou ``None`` se outro detem."""
    token = novo_token()
    ok = await client.set(key, token, nx=True, px=int(ttl_seconds * 1000))
    return token if ok else None


async def redis_release(client, key: str, token: str) -> bool:
    """Libera so se ainda for o dono. ``False`` quando o lock ja nao era seu."""
    return bool(await client.eval(_LIBERAR_SE_DONO, 1, key, token))


async def redis_extend(client, key: str, token: str, ttl_seconds: int) -> bool:
    """Renova o TTL so se ainda for o dono. ``False`` quando o lock foi perdido."""
    return bool(
        await client.eval(_RENOVAR_SE_DONO, 1, key, token, int(ttl_seconds * 1000))
    )


class InMemoryLocks:
    """Mesmas regras do Redis, em processo."""

    def __init__(self) -> None:
        self._locks: dict[str, tuple[str, float]] = {}

    def _dono_vivo(self, key: str) -> str | None:
        atual = self._locks.get(key)
        if atual is None:
            return None
        token, expira = atual
        if expira <= time.time():
            self._locks.pop(key, None)
            return None
        return token

    def acquire(self, key: str, ttl_seconds: int) -> str | None:
        if self._dono_vivo(key) is not None:
            return None
        token = novo_token()
        self._locks[key] = (token, time.time() + ttl_seconds)
        return token

    def release(self, key: str, token: str) -> bool:
        if self._dono_vivo(key) != token:
            return False
        self._locks.pop(key, None)
        return True

    def extend(self, key: str, token: str, ttl_seconds: int) -> bool:
        if self._dono_vivo(key) != token:
            return False
        self._locks[key] = (token, time.time() + ttl_seconds)
        return True

    def held(self, key: str) -> bool:
        return self._dono_vivo(key) is not None

    def expire_now(self, key: str) -> None:
        """Auxiliar de teste: simula o TTL vencendo sem esperar o relogio."""
        atual = self._locks.get(key)
        if atual is not None:
            self._locks[key] = (atual[0], 0.0)
