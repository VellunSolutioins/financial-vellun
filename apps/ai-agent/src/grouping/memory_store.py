"""Agrupamento em memoria — mesma semantica do Redis, sem durabilidade.

Usado nos testes e quando ``GROUP_STORE_BACKEND=memory`` (desenvolvimento sem
Docker). Nao serve a mais de uma instancia.
"""

from __future__ import annotations

import time

from ..config import settings
from .base import GroupEntry, GroupStore


class InMemoryGroupStore(GroupStore):
    def __init__(self) -> None:
        self._buffers: dict[str, list[GroupEntry]] = {}
        self._first: dict[str, float] = {}
        self._due: dict[str, float] = {}
        self._locks: dict[str, float] = {}

    async def append(self, phone: str, entry: GroupEntry) -> int:
        now = time.time()
        entries = self._buffers.setdefault(phone, [])
        entries.append(entry)
        self._first.setdefault(phone, now)

        max_due = self._first[phone] + settings.message_buffer_max_age_seconds
        if len(entries) >= settings.message_buffer_max_messages:
            due = now
        else:
            due = min(now + settings.message_buffer_debounce_seconds, max_due)
        self._due[phone] = due
        return len(entries)

    async def due_phones(self) -> list[str]:
        now = time.time()
        return [phone for phone, due in sorted(self._due.items()) if due <= now]

    async def peek(self, phone: str) -> list[GroupEntry]:
        return list(self._buffers.get(phone, []))

    async def clear(self, phone: str) -> None:
        self._buffers.pop(phone, None)
        self._first.pop(phone, None)
        self._due.pop(phone, None)

    async def acquire_lock(self, phone: str, ttl_seconds: int) -> bool:
        expires = self._locks.get(phone)
        now = time.time()
        if expires is not None and expires > now:
            return False
        self._locks[phone] = now + ttl_seconds
        return True

    async def release_lock(self, phone: str) -> None:
        self._locks.pop(phone, None)

    # ── Auxiliares de teste ─────────────────────────────────────────────────
    def force_due(self, phone: str) -> None:
        """Antecipa o vencimento do debounce (evita esperar 5s no teste)."""
        if phone in self._buffers:
            self._due[phone] = 0.0
