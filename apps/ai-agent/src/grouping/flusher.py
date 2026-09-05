"""Worker que consolida grupos vencidos e publica o job de processamento.

Sequencia por telefone (a ordem importa para nao perder mensagem):

1. adquire o lock distribuido do telefone;
2. **le** o grupo sem apagar;
3. monta o ``ProcessingJobV1`` com ``jobId`` deterministico;
4. publica e **aguarda o confirm** do broker;
5. so entao limpa o buffer e o agendamento;
6. libera o lock.

Se o processo cair entre 4 e 5, o grupo e republicado no proximo tick — mas com
o mesmo ``jobId``, entao o consumer de processamento o descarta como duplicata.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from ..config import settings
from ..messaging.base import ROUTE_PROCESSING, MessagePublisher
from ..messaging.contracts import ProcessingJobV1, derive_job_id, new_id, utcnow
from ..observability.logging import log_context
from ..services.metrics import metrics
from .base import GroupEntry, GroupStore

logger = logging.getLogger(__name__)


def build_job(phone: str, entries: list[GroupEntry]) -> ProcessingJobV1:
    """Consolida as mensagens do grupo, na ordem de recebimento."""
    combined = " ".join(entry.text.strip() for entry in entries if entry.text.strip())
    source_ids = [e.ai_message_id for e in entries if e.ai_message_id]
    provider_ids = [e.provider_message_id for e in entries if e.provider_message_id]
    prefix = "".join(e.response_prefix for e in entries if e.response_prefix)
    timestamps = sorted(_parse(e.received_at) for e in entries)
    correlation = next((e.correlation_id for e in entries if e.correlation_id), None)

    return ProcessingJobV1(
        job_id=derive_job_id(
            phone=phone, source_message_ids=source_ids, provider_message_ids=provider_ids
        ),
        phone=phone,
        combined_message=combined,
        source_message_ids=source_ids,
        provider_message_ids=provider_ids,
        first_received_at=timestamps[0] if timestamps else utcnow(),
        last_received_at=timestamps[-1] if timestamps else utcnow(),
        correlation_id=correlation or new_id(),
        response_prefix=prefix,
    )


def _parse(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return utcnow()


class GroupFlusherWorker:
    def __init__(self, store: GroupStore, publisher: MessagePublisher) -> None:
        self._store = store
        self._publisher = publisher
        self._task: asyncio.Task | None = None
        self._running = False

    def start(self) -> None:
        if self._task is None:
            self._running = True
            self._task = asyncio.create_task(self._run())
            logger.info("Worker de agrupamento iniciado")

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def is_running(self) -> bool:
        return self._running

    async def _run(self) -> None:
        while self._running:
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 - o worker nunca deve morrer
                logger.exception("Erro no tick do worker de agrupamento")
            await asyncio.sleep(settings.worker_poll_interval_seconds)

    async def tick(self) -> int:
        """Consolida todos os grupos vencidos. Retorna quantos foram publicados."""
        published = 0
        for phone in await self._store.due_phones():
            if await self._flush_phone(phone):
                published += 1
        return published

    async def _flush_phone(self, phone: str) -> bool:
        if not await self._store.acquire_lock(phone, settings.redis_lock_ttl_seconds):
            # Outra instancia ja esta consolidando este telefone.
            return False
        try:
            entries = await self._store.peek(phone)
            if not entries:
                await self._store.clear(phone)
                return False

            job = build_job(phone, entries)
            with log_context(correlation_id=job.correlation_id, job_id=job.job_id, phone=phone):
                await self._publisher.publish(
                    ROUTE_PROCESSING, job, correlation_id=job.correlation_id
                )
                # Publicacao confirmada: agora e seguro limpar o buffer.
                await self._store.clear(phone)
                metrics.incr("group_flushed")
                metrics.incr("jobs_published")
                logger.info(
                    "Grupo consolidado e publicado (%d mensagem(ns))", len(entries)
                )
            return True
        except Exception:
            metrics.incr("group_flush_failed")
            logger.exception("Falha ao consolidar grupo; buffer preservado para retry")
            return False
        finally:
            await self._store.release_lock(phone)
