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

from ..config import settings
from ..messaging.contracts import utcnow


def due_at(now: float, first_at: float, length: int) -> float:
    """Quando o grupo deve ser consolidado.

    Imediato ao atingir o limite de mensagens; senao, ``now + debounce``, nunca
    passando de ``first_at + idade maxima``. O teto conta da **primeira**
    mensagem do grupo, entao um fluxo continuo nao adia o flush para sempre.
    """
    if length >= settings.message_buffer_max_messages:
        return now
    return min(
        now + settings.message_buffer_debounce_seconds,
        first_at + settings.message_buffer_max_age_seconds,
    )


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
    async def peek(self, phone: str, limit: int | None = None) -> list[GroupEntry]:
        """Le as primeiras ``limit`` mensagens **sem** remover.

        Nao remove porque a limpeza so pode acontecer depois do confirm da
        publicacao: melhor republicar (o job e deduplicado) do que perder.
        """

    @abstractmethod
    async def consume(self, phone: str, count: int) -> int:
        """Descarta as ``count`` primeiras mensagens, ja publicadas.

        Devolve quantas restaram. Se sobrou alguma, o telefone e reagendado com
        a mesma regra do ``append`` — o excedente vira o proximo grupo em vez de
        engordar o atual.
        """

    @abstractmethod
    async def clear(self, phone: str) -> None:
        """Remove o grupo inteiro e o agendamento."""

    @abstractmethod
    async def acquire_lock(self, phone: str, ttl_seconds: int) -> bool:
        """Lock distribuido do telefone durante a consolidacao."""

    @abstractmethod
    async def release_lock(self, phone: str) -> None:
        """Libera o lock."""
