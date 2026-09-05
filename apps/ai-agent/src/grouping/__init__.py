"""Agrupamento (debounce) distribuido de mensagens por telefone."""

from .base import GroupEntry, GroupStore
from .factory import get_group_store, set_group_store
from .flusher import GroupFlusherWorker, build_job
from .memory_store import InMemoryGroupStore

__all__ = [
    "GroupEntry",
    "GroupFlusherWorker",
    "GroupStore",
    "InMemoryGroupStore",
    "build_job",
    "get_group_store",
    "set_group_store",
]
