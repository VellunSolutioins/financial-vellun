"""Limite diário de mensagens processadas por telefone (plano de segurança, S2).

Sem teto, um único número gerava custo ilimitado de LLM, transcrição e visão.
"""

from __future__ import annotations

from src.config import settings
from src.services.distributed_state import InMemoryStateStore, get_state_store
from src.services.usage_limiter import UsageLimiter

PHONE = "+5541999990000"


async def test_permite_ate_o_limite_e_bloqueia_depois(monkeypatch):
    monkeypatch.setattr(settings, "ai_daily_message_limit", 3)
    limiter = UsageLimiter()

    resultados = [await limiter.allow(PHONE) for _ in range(5)]

    assert resultados == [True, True, True, False, False]


async def test_contadores_sao_por_telefone(monkeypatch):
    monkeypatch.setattr(settings, "ai_daily_message_limit", 1)
    limiter = UsageLimiter()

    assert await limiter.allow(PHONE) is True
    assert await limiter.allow("+5541999990001") is True
    assert await limiter.allow(PHONE) is False


async def test_zero_desliga_o_limite(monkeypatch):
    monkeypatch.setattr(settings, "ai_daily_message_limit", 0)
    limiter = UsageLimiter()

    assert all([await limiter.allow(PHONE) for _ in range(10)])


async def test_contador_expira_com_a_janela():
    store = InMemoryStateStore()

    assert await store.incr("k", ttl_seconds=60) == 1
    assert await store.incr("k", ttl_seconds=60) == 2
    store._entries["k"] = 0  # simula o TTL vencido
    assert await store.incr("k", ttl_seconds=60) == 1


def test_store_padrao_dos_testes_e_em_memoria():
    assert isinstance(get_state_store(), InMemoryStateStore)
