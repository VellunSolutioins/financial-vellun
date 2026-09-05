"""Selecao do backend de agrupamento (``GROUP_STORE_BACKEND``)."""

from __future__ import annotations

import logging

from ..config import settings
from .base import GroupStore
from .memory_store import InMemoryGroupStore

logger = logging.getLogger(__name__)

_store: GroupStore | None = None


def get_group_store() -> GroupStore:
    global _store
    if _store is None:
        backend = (settings.group_store_backend or "redis").strip().lower()
        if backend == "memory":
            logger.info("Agrupamento usando backend em memoria")
            _store = InMemoryGroupStore()
        else:
            from .redis_store import RedisGroupStore

            logger.info("Agrupamento usando Redis")
            _store = RedisGroupStore()
    return _store


def set_group_store(store: GroupStore | None) -> None:
    """Injeta um store (testes) ou zera o singleton."""
    global _store
    _store = store
