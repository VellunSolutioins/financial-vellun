"""Estado de conversa em memória, com TTL, indexado por número de telefone.

Suficiente para o MVP (§9.4 — fora de escopo persistir contexto em banco).
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from ..config import settings
from ..schemas.financial_intent import FinancialIntent


@dataclass
class ConversationState:
    pending_intent: FinancialIntent | None = None
    awaiting_confirmation: bool = False
    last_message_at: datetime = field(default_factory=datetime.utcnow)


class ConversationManager:
    def __init__(self, ttl_minutes: int | None = None) -> None:
        self._ttl = timedelta(minutes=ttl_minutes or settings.conversation_ttl_minutes)
        self._states: dict[str, ConversationState] = {}

    def get(self, phone: str) -> ConversationState:
        state = self._states.get(phone)
        if state is None or self._is_expired(state):
            state = ConversationState()
            self._states[phone] = state
        return state

    def set_pending(self, phone: str, intent: FinancialIntent) -> None:
        self._states[phone] = ConversationState(
            pending_intent=intent,
            awaiting_confirmation=True,
            last_message_at=datetime.utcnow(),
        )

    def clear(self, phone: str) -> None:
        self._states.pop(phone, None)

    def touch(self, phone: str) -> None:
        state = self.get(phone)
        state.last_message_at = datetime.utcnow()

    def _is_expired(self, state: ConversationState) -> bool:
        return datetime.utcnow() - state.last_message_at > self._ttl


conversation_manager = ConversationManager()
