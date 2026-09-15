"""Estado de conversa por telefone (confirmacoes pendentes), com TTL.

A API continua a mesma (``get``/``set_pending``/``clear``), mas agora e
**assincrona** e apoiada em um store distribuido — por padrao Redis, para que a
confirmacao pendente sobreviva a restart e funcione entre instancias
(``CONVERSATION_STATE_BACKEND=memory`` mantem o comportamento antigo, util em
testes e no modo legado).
"""

from __future__ import annotations

import logging

from ..config import settings
from ..schemas.financial_intent import FinancialIntent
from .conversation_store import (
    ConversationState,
    ConversationStore,
    InMemoryConversationStore,
    RedisConversationStore,
)

logger = logging.getLogger(__name__)

__all__ = ["ConversationManager", "ConversationState", "conversation_manager"]


def _create_store() -> ConversationStore:
    backend = (settings.conversation_state_backend or "redis").strip().lower()
    if backend == "memory":
        logger.info("Estado de conversa em memoria")
        return InMemoryConversationStore()
    logger.info("Estado de conversa no Redis")
    return RedisConversationStore()


class ConversationManager:
    def __init__(self, store: ConversationStore | None = None) -> None:
        self._store = store
        self._ttl_seconds = settings.conversation_state_ttl_seconds

    @property
    def store(self) -> ConversationStore:
        if self._store is None:
            self._store = _create_store()
        return self._store

    def use_store(self, store: ConversationStore | None) -> None:
        """Injeta um store (testes) ou forca a recriacao pelo backend configurado."""
        self._store = store

    async def get(self, phone: str) -> ConversationState:
        """Estado atual; expirado ou inexistente devolve um estado vazio."""
        state = await self.store.get(phone)
        if state is None:
            return ConversationState()
        if state.is_expired(self._ttl_seconds):
            await self.store.clear(phone)
            return ConversationState()
        return state

    async def set_pending(self, phone: str, intent: FinancialIntent) -> None:
        await self.store.save(
            phone,
            ConversationState(pending_intent=intent, awaiting_confirmation=True),
        )

    async def clear(self, phone: str) -> None:
        await self.store.clear(phone)

    async def touch(self, phone: str) -> None:
        state = await self.get(phone)
        await self.store.save(phone, ConversationState(
            pending_intent=state.pending_intent,
            awaiting_confirmation=state.awaiting_confirmation,
        ))


conversation_manager = ConversationManager()
