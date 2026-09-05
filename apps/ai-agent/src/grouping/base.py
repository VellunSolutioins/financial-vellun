"""Contrato do agrupamento (debounce) de mensagens por telefone.

Preserva o comportamento existente — debounce de 5s, no maximo 10 mensagens,
idade maxima de 30s, ordem de recebimento — mas de forma **distribuida**: o
estado vive no Redis e a consolidacao e protegida por lock, para que duas
instancias nunca consolidem o mesmo grupo.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field

from ..messaging.contracts import utcnow


@dataclass
class GroupEntry:
    """Uma mensagem ja persistida, aguardando consolidacao."""

    text: str
    ai_message_id: str | None = None
    provider_message_id: str | None = None
    received_at: str = field(default_factory=lambda: utcnow().isoformat())
    # Eco da transcricao de audio, prefixado na resposta final.
    response_prefix: str = ""
    correlation_id: str | None = None

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @staticmethod
    def from_json(raw: str) -> "GroupEntry":
        return GroupEntry(**json.loads(raw))


class GroupStore(ABC):
    """Buffer por telefone com agendamento de flush e exclusao mutua."""

    @abstractmethod
    async def append(self, phone: str, entry: GroupEntry) -> int:
        """Adiciona a mensagem e (re)agenda o flush. Retorna o tamanho do grupo."""

    @abstractmethod
    async def due_phones(self) -> list[str]:
        """Telefones cujo debounce venceu."""

    @abstractmethod
    async def peek(self, phone: str) -> list[GroupEntry]:
        """Le o grupo **sem** remover (so limpamos apos o confirm da publicacao)."""

    @abstractmethod
    async def clear(self, phone: str) -> None:
        """Remove o grupo e o agendamento."""

    @abstractmethod
    async def acquire_lock(self, phone: str, ttl_seconds: int) -> bool:
        """Lock distribuido do telefone durante a consolidacao."""

    @abstractmethod
    async def release_lock(self, phone: str) -> None:
        """Libera o lock."""
