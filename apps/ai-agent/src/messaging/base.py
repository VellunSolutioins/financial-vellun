"""Abstrações de broker: publisher, consumer e política de ack/retry/DLQ.

Nada aqui conhece RabbitMQ. Os drivers concretos (``rabbitmq/``, ``inmemory``)
implementam :class:`MessagePublisher`/:class:`MessageConsumer` e reutilizam
:func:`dispatch`, para que a política de ack seja idêntica em todos eles.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel

logger = logging.getLogger(__name__)

#: Routing keys lógicas (o nome físico da fila vem da configuração).
ROUTE_INBOUND = "inbound"
ROUTE_PROCESSING = "processing"

#: Header que carrega o número da tentativa entre republicações.
HEADER_ATTEMPT = "x-attempt"
HEADER_FIRST_FAILED_AT = "x-first-failed-at"
HEADER_DEFER_COUNT = "x-defer-count"


class BrokerError(Exception):
    """Erro genérico da camada de mensageria."""


class TransientError(BrokerError):
    """Falha temporária (rede, timeout, 5xx, rate limit): gera retry."""


class PermanentError(BrokerError):
    """Falha definitiva (contrato inválido, tipo não suportado): vai para a DLQ."""


class PublishError(TransientError):
    """Não foi possível garantir a publicação (sem confirm do broker)."""


class DeferError(BrokerError):
    """Não é hora de processar (ex.: o telefone está travado por outro worker).

    Reagenda no menor bucket **sem** consumir uma tentativa: adiar por
    concorrência não é falha e não pode empurrar a mensagem para a DLQ.
    """


@dataclass
class BrokerMessage:
    """Mensagem crua entregue ao handler, independente do broker."""

    body: bytes
    routing_key: str
    attempt: int = 0
    correlation_id: str | None = None
    headers: dict[str, Any] = field(default_factory=dict)
    first_failed_at: str | None = None


MessageHandler = Callable[[BrokerMessage], Awaitable[None]]
RetryCallback = Callable[[BrokerMessage, BaseException, bool], Awaitable[None]]
DlqCallback = Callable[[BrokerMessage, BaseException, bool], Awaitable[None]]


class MessagePublisher(ABC):
    """Publica mensagens com confirmação do broker."""

    @abstractmethod
    async def start(self) -> None:
        """Estabelece conexão/canal e declara a topologia."""

    @abstractmethod
    async def stop(self) -> None:
        """Fecha a conexão."""

    @abstractmethod
    async def publish(
        self,
        routing_key: str,
        message: BaseModel,
        *,
        correlation_id: str | None = None,
        headers: dict[str, Any] | None = None,
    ) -> None:
        """Publica e **aguarda o confirm**. Levanta :class:`PublishError` se falhar."""

    async def publish_many(
        self,
        routing_key: str,
        messages: Sequence[BaseModel],
        *,
        correlation_id: str | None = None,
    ) -> None:
        """Publica várias mensagens, todas confirmadas, preservando a ordem."""
        for message in messages:
            await self.publish(routing_key, message, correlation_id=correlation_id)

    @abstractmethod
    async def healthy(self) -> bool:
        """``True`` quando é possível publicar agora (usado pelo readiness)."""


class MessageConsumer(ABC):
    """Consome uma fila com ack manual e concorrência limitada."""

    @abstractmethod
    async def start(self, handler: MessageHandler) -> None:
        """Começa a consumir, entregando cada mensagem ao ``handler``."""

    @abstractmethod
    async def stop(self, drain_timeout: float = 20.0) -> None:
        """Para de receber, aguarda o que está em voo e devolve o que sobrar."""

    @abstractmethod
    async def healthy(self) -> bool:
        """``True`` quando o consumo está ativo."""


async def dispatch(
    message: BrokerMessage,
    handler: MessageHandler,
    *,
    max_retries: int,
    on_retry: RetryCallback,
    on_dlq: DlqCallback,
) -> str:
    """Executa o handler e decide o destino: ``ack``, ``retry`` ou ``dlq``.

    Política única, compartilhada por todos os drivers:

    - sucesso → ``ack``;
    - :class:`DeferError` → reagenda sem consumir tentativa;
    - :class:`PermanentError` (ou contrato inválido) → DLQ, sem retry;
    - qualquer outra exceção → retry com backoff, até ``max_retries``
      tentativas; esgotadas, vai para a DLQ.
    """
    try:
        await handler(message)
        return "ack"
    except DeferError as exc:
        logger.debug("Mensagem adiada: %s", exc)
        await on_retry(message, exc, False)
        return "defer"
    except PermanentError as exc:
        logger.warning("Falha permanente; enviando para DLQ: %s", exc)
        await on_dlq(message, exc, True)
        return "dlq"
    except Exception as exc:  # noqa: BLE001 — transitório por padrão
        if message.attempt + 1 >= max_retries:
            logger.error(
                "Tentativas esgotadas (%d); enviando para DLQ", message.attempt + 1, exc_info=exc
            )
            await on_dlq(message, exc, False)
            return "dlq"
        logger.warning(
            "Falha transitória na tentativa %d; reagendando", message.attempt + 1, exc_info=exc
        )
        await on_retry(message, exc, True)
        return "retry"
