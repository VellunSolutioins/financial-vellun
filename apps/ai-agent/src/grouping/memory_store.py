"""Agrupamento em memoria — mesma semantica do Redis, sem durabilidade.

Usado nos testes e quando ``GROUP_STORE_BACKEND=memory`` (desenvolvimento sem
Docker). Nao serve a mais de uma instancia.
"""

from __future__ import annotations

import time

from ..services.locks import InMemoryLocks
from .base import AppendResult, GroupEntry, GroupStore, due_at


class InMemoryGroupStore(GroupStore):
    def __init__(self) -> None:
        self._buffers: dict[str, list[GroupEntry]] = {}
        self._first: dict[str, float] = {}
        self._due: dict[str, float] = {}
        self._locks = InMemoryLocks()

    async def append(self, phone: str, entry: GroupEntry) -> AppendResult:
        now = time.time()
        entries = self._buffers.setdefault(phone, [])

        if entry.provider_message_id is not None and any(
            existing.provider_message_id == entry.provider_message_id
            for existing in entries
        ):
            return AppendResult(length=len(entries), added=False)

        entries.append(entry)
        self._first.setdefault(phone, now)

        self._due[phone] = due_at(now, self._first[phone], len(entries))
        return AppendResult(length=len(entries), added=True)

    async def due_phones(self) -> list[str]:
        now = time.time()
        return [phone for phone, due in sorted(self._due.items()) if due <= now]

    async def peek(self, phone: str, limit: int | None = None) -> list[GroupEntry]:
        entries = self._buffers.get(phone, [])
        return list(entries if limit is None else entries[:limit])

    async def consume(self, phone: str, count: int) -> int:
        now = time.time()
        restantes = self._buffers.get(phone, [])[count:]
        if not restantes:
            await self.clear(phone)
            return 0

        # O excedente vira um grupo novo: o teto de idade passa a contar daqui.
        self._buffers[phone] = restantes
        self._first[phone] = now
        self._due[phone] = due_at(now, now, len(restantes))
        return len(restantes)

    async def clear(self, phone: str) -> None:
        self._buffers.pop(phone, None)
        self._first.pop(phone, None)
        self._due.pop(phone, None)

    async def acquire_lock(self, phone: str, ttl_seconds: int) -> str | None:
        return self._locks.acquire(phone, ttl_seconds)

    async def extend_lock(self, phone: str, token: str, ttl_seconds: int) -> bool:
        return self._locks.extend(phone, token, ttl_seconds)

    async def release_lock(self, phone: str, token: str) -> bool:
        return self._locks.release(phone, token)

    def expire_lock_now(self, phone: str) -> None:
        """Auxiliar de teste: simula o TTL do lock vencendo."""
        self._locks.expire_now(phone)

    # ── Auxiliares de teste ─────────────────────────────────────────────────
    def force_due(self, phone: str) -> None:
        """Antecipa o vencimento do debounce (evita esperar 5s no teste)."""
        if phone in self._buffers:
            self._due[phone] = 0.0
