"""Buffer/debounce de mensagens fragmentadas por telefone (Etapa 2 do plano).

O WhatsApp costuma quebrar uma instrução em várias mensagens curtas
("gastei" / "47,50" / "no mercado"). Em vez de processar cada uma isolada, o
buffer agrupa as mensagens de um mesmo telefone dentro de uma janela de
*debounce* e dispara **um** processamento consolidado.

Garantias:
- a mensagem inbound é persistida **antes** de entrar no buffer (§3.1);
- flush serializado por telefone via lock (telefones distintos são isolados);
- flush imediato ao atingir ``max_messages`` ou ``max_age`` (§9.2);
- interface :class:`BufferBackend` abstrata — backend em memória agora,
  Redis na Etapa 5.
"""

from __future__ import annotations

import asyncio
import logging
import time
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from ..config import settings
from .audit_service import audit_service
from .metrics import metrics

logger = logging.getLogger(__name__)

FlushCallback = Callable[[str, list["BufferedMessage"]], Awaitable[None]]


@dataclass
class BufferedMessage:
    """Uma mensagem inbound já persistida, aguardando consolidação."""

    text: str
    persisted_message_id: str | None = None
    provider_message_id: str | None = None
    received_at: float = field(default_factory=time.monotonic)


@dataclass
class PhoneBuffer:
    """Mensagens acumuladas de um telefone + agendamento do flush."""

    messages: list[BufferedMessage] = field(default_factory=list)
    timer: asyncio.TimerHandle | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    first_received_at: float | None = None
    seen_provider_ids: set[str] = field(default_factory=set)


class BufferBackend(ABC):
    """Contrato de armazenamento/agendamento do buffer de mensagens."""

    @abstractmethod
    async def add(self, phone: str, message: BufferedMessage) -> None:
        """Adiciona a mensagem ao buffer do telefone e (re)agenda o flush."""
        raise NotImplementedError


class MemoryBufferBackend(BufferBackend):
    """Backend em memória com debounce baseado em ``asyncio`` (MVP)."""

    def __init__(self, flush_callback: FlushCallback) -> None:
        self._flush = flush_callback
        self._buffers: dict[str, PhoneBuffer] = {}

    def _get(self, phone: str) -> PhoneBuffer:
        buf = self._buffers.get(phone)
        if buf is None:
            buf = PhoneBuffer()
            self._buffers[phone] = buf
        return buf

    async def add(self, phone: str, message: BufferedMessage) -> None:
        buf = self._get(phone)

        # Deduplica por id do provedor dentro da janela do buffer (§4/Etapa 4).
        pid = message.provider_message_id
        if pid is not None and pid in buf.seen_provider_ids:
            logger.info("Mensagem duplicada ignorada no buffer (provider_id=%s)", pid)
            return
        if pid is not None:
            buf.seen_provider_ids.add(pid)

        if not buf.messages:
            buf.first_received_at = time.monotonic()
        buf.messages.append(message)

        # Flush imediato ao atingir o limite de mensagens.
        if len(buf.messages) >= settings.message_buffer_max_messages:
            logger.info("Buffer de %s atingiu max_messages; flush imediato", phone)
            await self._flush_now(phone)
            return

        # Flush imediato ao exceder a idade máxima da janela.
        age = time.monotonic() - (buf.first_received_at or time.monotonic())
        if age >= settings.message_buffer_max_age_seconds:
            logger.info("Buffer de %s excedeu max_age; flush imediato", phone)
            await self._flush_now(phone)
            return

        self._reschedule(phone, buf)

    def _reschedule(self, phone: str, buf: PhoneBuffer) -> None:
        """(Re)agenda o flush por debounce, cancelando o timer anterior."""
        if buf.timer is not None:
            buf.timer.cancel()
        loop = asyncio.get_running_loop()
        buf.timer = loop.call_later(
            settings.message_buffer_debounce_seconds,
            lambda: asyncio.ensure_future(self._flush_now(phone)),
        )

    async def _flush_now(self, phone: str) -> None:
        buf = self._buffers.get(phone)
        if buf is None:
            return

        # Serializa o flush por telefone (telefones distintos são isolados).
        async with buf.lock:
            buf = self._buffers.get(phone)
            if buf is None or not buf.messages:
                return

            if buf.timer is not None:
                buf.timer.cancel()
                buf.timer = None

            # Limpeza atômica: remove o buffer antes de processar.
            messages = buf.messages
            self._buffers.pop(phone, None)

        try:
            await self._flush(phone, messages)
        except Exception:  # noqa: BLE001 — falha no processamento não derruba o worker
            logger.exception("Falha ao processar buffer de %s", phone)


class MessageBuffer:
    """Fachada de ingestão: persiste inbound e delega ao backend de buffer."""

    def __init__(self, backend: BufferBackend | None = None) -> None:
        self._backend = backend or self._create_backend()

    def _create_backend(self) -> BufferBackend:
        backend = (settings.message_buffer_backend or "memory").lower()
        if backend == "redis":
            # Import tardio: evita ciclo e torna redis opcional no modo memória.
            from .redis_buffer import RedisBufferBackend

            logger.info("Buffer de mensagens usando backend Redis")
            return RedisBufferBackend(self._on_flush)
        logger.info("Buffer de mensagens usando backend em memória")
        return MemoryBufferBackend(self._on_flush)

    async def start(self) -> None:
        """Inicia o worker do backend, se houver (Redis)."""
        start_worker = getattr(self._backend, "start_worker", None)
        if start_worker is not None:
            start_worker()

    async def stop(self) -> None:
        """Encerra o worker do backend, se houver (Redis)."""
        stop_worker = getattr(self._backend, "stop_worker", None)
        if stop_worker is not None:
            await stop_worker()

    async def add(
        self,
        phone: str,
        message: str,
        provider_message_id: str | None = None,
        provider_timestamp: int | None = None,
    ) -> None:
        """Persiste a inbound (§3.1) e a enfileira para processamento."""
        metadata: dict = {}
        if provider_message_id is not None:
            metadata["messageId"] = provider_message_id
        if provider_timestamp is not None:
            metadata["timestamp"] = provider_timestamp

        result = await audit_service.log_message_detailed(
            phone, "inbound", message, metadata=metadata or None
        )

        # Idempotência: reenvio do mesmo webhook (já gravado) não é processado
        # de novo, mesmo após o fim da janela do buffer.
        if result and result.get("duplicate"):
            metrics.incr("inbound_duplicate")
            logger.info(
                "Inbound duplicada ignorada (provider_id=%s)", provider_message_id
            )
            return

        metrics.incr("inbound_buffered")

        persisted_id = result.get("id") if result else None

        await self._backend.add(
            phone,
            BufferedMessage(
                text=message,
                persisted_message_id=persisted_id,
                provider_message_id=provider_message_id,
            ),
        )

    async def _on_flush(self, phone: str, messages: list[BufferedMessage]) -> None:
        # Import tardio evita ciclo (processor importa serviços que importam isto).
        from .message_processor import message_processor

        combined = " ".join(m.text.strip() for m in messages if m.text.strip())
        source_ids = [m.persisted_message_id for m in messages if m.persisted_message_id]

        metrics.incr("buffer_flush")
        oldest = min((m.received_at for m in messages), default=time.monotonic())
        metrics.observe_ms("receive_to_process_ms", (time.monotonic() - oldest) * 1000)

        logger.info(
            "Flush do buffer de %s: %d mensagem(ns) consolidada(s)", phone, len(messages)
        )
        await message_processor.process_buffered_message(phone, combined, source_ids)


message_buffer = MessageBuffer()
