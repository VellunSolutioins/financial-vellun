"""Regras do lock com dono, na implementação em memória.

Os scripts Lua do Redis são exercitados em `test_broker_integration.py`, contra
o Redis real. Aqui ficam as mesmas regras sem infraestrutura, para rodar sempre.
"""

from __future__ import annotations

from src.grouping import InMemoryGroupStore
from src.services.locks import InMemoryLocks


def test_so_um_dono_por_vez():
    locks = InMemoryLocks()

    token = locks.acquire("k", 60)

    assert token is not None
    assert locks.acquire("k", 60) is None


def test_token_errado_nao_libera_nem_renova():
    locks = InMemoryLocks()
    token = locks.acquire("k", 60)

    assert locks.release("k", "token-de-outro") is False
    assert locks.extend("k", "token-de-outro", 60) is False
    assert locks.held("k")
    assert locks.release("k", token) is True
    assert not locks.held("k")


def test_dono_atrasado_nao_apaga_o_lock_de_quem_entrou_depois():
    """O cenário exato do defeito relatado na revisão."""
    locks = InMemoryLocks()
    token_a = locks.acquire("k", 60)
    locks.expire_now("k")  # o processamento de A passou do TTL
    token_b = locks.acquire("k", 60)
    assert token_b is not None

    # A termina e tenta liberar: antes era DELETE incondicional.
    assert locks.release("k", token_a) is False

    # B continua dono, e um terceiro não entra.
    assert locks.acquire("k", 60) is None
    assert locks.release("k", token_b) is True


def test_renovar_depois_de_expirar_nao_ressuscita_o_lock():
    locks = InMemoryLocks()
    token = locks.acquire("k", 60)
    locks.expire_now("k")

    assert locks.extend("k", token, 60) is False
    assert locks.acquire("k", 60) is not None


def test_renovar_pelo_dono_estende_o_prazo():
    locks = InMemoryLocks()
    token = locks.acquire("k", 60)

    assert locks.extend("k", token, 3600) is True
    assert locks.held("k")


def test_cada_aquisicao_recebe_um_token_proprio():
    locks = InMemoryLocks()
    primeiro = locks.acquire("k", 60)
    locks.release("k", primeiro)

    # Reaproveitar o token permitiria ao dono antigo liberar o lock novo.
    assert locks.acquire("k", 60) != primeiro


async def test_store_de_agrupamento_segue_as_mesmas_regras():
    store = InMemoryGroupStore()
    token_a = await store.acquire_lock("+5541999999999", 30)
    store.expire_lock_now("+5541999999999")
    token_b = await store.acquire_lock("+5541999999999", 30)

    assert await store.release_lock("+5541999999999", token_a) is False
    assert await store.extend_lock("+5541999999999", token_a, 30) is False
    assert await store.release_lock("+5541999999999", token_b) is True
