"""Persistencia do estado de conversa (confirmacoes pendentes).

O estado precisa sobreviver a restart e ser visivel por todas as instancias:
sem isso, o usuario responde "sim" e cai em um worker que nao conhece a
pergunta. Guardamos em Redis, com serializacao **versionada** do
``FinancialIntent`` e TTL configuravel.

Atomicidade: cada operacao e um unico comando Redis (GET/SET/DEL), portanto
atomica. A sequencia ler -> decidir -> gravar do processamento e serializada
pelo lock por telefone do ``MessageProcessingConsumer``.
"""

from __future__ import annotations

import json
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from ..config import settings
from ..schemas.financial_intent import FinancialIntent
from .redis_client import RedisProvider, redis_provider

logger = logging.getLogger(__name__)

STATE_SCHEMA_VERSION = 1


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class ConversationState:
    pending_intent: FinancialIntent | None = None
    awaiting_confirmation: bool = False
    last_message_at: datetime = field(default_factory=_utcnow)

    def to_json(self) -> str:
        return json.dumps(
            {
                "v": STATE_SCHEMA_VERSION,
                "pendingIntent": (
                    self.pending_intent.model_dump(mode="json")
                    if self.pending_intent is not None
                    else None
                ),
                "awaitingConfirmation": self.awaiting_confirmation,
                "lastMessageAt": self.last_message_at.isoformat(),
            },
            ensure_ascii=False,
        )

    @staticmethod
    def from_json(raw: str) -> "ConversationState | None":
        """Desserializa; versao desconhecida ou corrompida vira estado vazio."""
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            logger.warning("Estado de conversa corrompido; descartando")
            return None
        if data.get("v") != STATE_SCHEMA_VERSION:
            logger.info("Estado de conversa em versao antiga (%s); descartando", data.get("v"))
            return None

        pending = data.get("pendingIntent")
        try:
            intent = FinancialIntent(**pending) if pending else None
        except Exception:  # noqa: BLE001 - schema do intent mudou
            logger.warning("Intent pendente incompativel; descartando")
            return None

        try:
            last = datetime.fromisoformat(data["lastMessageAt"])
        except (KeyError, TypeError, ValueError):
            last = _utcnow()

        return ConversationState(
            pending_intent=intent,
            awaiting_confirmation=bool(data.get("awaitingConfirmation")),
            last_message_at=last,
        )

    def is_expired(self, ttl_seconds: int) -> bool:
        return _utcnow() - self.last_message_at > timedelta(seconds=ttl_seconds)


class ConversationStore(ABC):
    @abstractmethod
    async def get(self, phone: str) -> ConversationState | None: ...

    @abstractmethod
    async def save(self, phone: str, state: ConversationState) -> None: ...

    @abstractmethod
    async def clear(self, phone: str) -> None: ...


class InMemoryConversationStore(ConversationStore):
    """Estado por processo. Nao sobrevive a restart nem serve a varias instancias."""

    def __init__(self) -> None:
        self._states: dict[str, ConversationState] = {}

    async def get(self, phone: str) -> ConversationState | None:
        return self._states.get(phone)

    async def save(self, phone: str, state: ConversationState) -> None:
        self._states[phone] = state

    async def clear(self, phone: str) -> None:
        self._states.pop(phone, None)


class RedisConversationStore(ConversationStore):
    def __init__(self, provider: RedisProvider | None = None) -> None:
        self._provider = provider or redis_provider

    @staticmethod
    def _key(phone: str) -> str:
        return f"conv:{phone}"

    async def get(self, phone: str) -> ConversationState | None:
        client = await self._provider.client()
        raw = await client.get(self._key(phone))
        return ConversationState.from_json(raw) if raw else None

    async def save(self, phone: str, state: ConversationState) -> None:
        client = await self._provider.client()
        await client.set(
            self._key(phone), state.to_json(), ex=settings.conversation_state_ttl_seconds
        )

    async def clear(self, phone: str) -> None:
        client = await self._provider.client()
        await client.delete(self._key(phone))
