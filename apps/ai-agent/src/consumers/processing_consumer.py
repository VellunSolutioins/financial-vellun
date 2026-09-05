"""Consumer de ``whatsapp.processing.v1``.

Executa o fluxo que antes começava no ``MessageProcessor``: contato →
assinatura → contexto → confirmação pendente → IA → lançamento → resposta →
outbound.

Garantias:

- **idempotência** — o ``jobId`` é determinístico e fica marcado como concluído;
  uma reentrega depois do ack não reprocessa, e o mesmo ``jobId`` vira a chave
  de idempotência do lançamento na API;
- **ordenação por telefone** — lock distribuído durante todo o processamento.
  Um job cujo telefone está ocupado é adiado (sem consumir tentativa), então a
  confirmação nunca é processada antes da pergunta;
- **concorrência limitada** — o número de jobs simultâneos vem de
  ``PROCESSING_CONSUMER_CONCURRENCY`` (o semáforo vive no consumer do broker).
"""

from __future__ import annotations

import logging
import time

from pydantic import ValidationError

from ..config import settings
from ..messaging.base import HEADER_DEFER_COUNT, BrokerMessage, DeferError, PermanentError
from ..messaging.contracts import ProcessingJobV1, utcnow
from ..observability.logging import log_context
from ..services.distributed_state import StateStore, get_state_store
from ..services.message_processor import message_processor
from ..services.metrics import metrics

logger = logging.getLogger(__name__)

#: Depois disso, um job adiado passa a contar tentativas — evita adiar para sempre
#: caso um lock fique preso por um bug.
MAX_DEFERS = 60


def lock_key(phone: str) -> str:
    return f"proc:lock:{phone}"


def done_key(job_id: str) -> str:
    return f"job:done:{job_id}"


class MessageProcessingConsumer:
    def __init__(self, store: StateStore | None = None) -> None:
        self._store = store

    @property
    def store(self) -> StateStore:
        if self._store is None:
            self._store = get_state_store()
        return self._store

    async def handle(self, broker_message: BrokerMessage) -> None:
        try:
            job = ProcessingJobV1.model_validate_json(broker_message.body)
        except ValidationError as exc:
            raise PermanentError(
                f"contrato de job inválido: {exc.error_count()} erro(s)"
            ) from exc

        with log_context(
            correlation_id=job.correlation_id, job_id=job.job_id, phone=job.phone
        ):
            if await self.store.exists(done_key(job.job_id)):
                metrics.incr("jobs_duplicated")
                logger.info("Job já concluído; ignorando reentrega")
                return

            if not await self.store.acquire(
                lock_key(job.phone), settings.processing_lock_ttl_seconds
            ):
                defers = _defer_count(broker_message)
                if defers >= MAX_DEFERS:
                    raise RuntimeError(
                        "telefone travado por tempo excessivo; tratando como falha"
                    )
                metrics.incr("jobs_deferred")
                raise DeferError("telefone já em processamento por outro worker")

            try:
                await self._process(job)
            finally:
                await self.store.release(lock_key(job.phone))

    async def _process(self, job: ProcessingJobV1) -> None:
        started = time.monotonic()
        metrics.observe_ms(
            "receive_to_process_ms",
            max((utcnow() - job.first_received_at).total_seconds() * 1000, 0.0),
        )

        await message_processor.process_job(job)

        # Só marca como concluído depois que o estado final está persistido
        # (lançamento criado ou confirmação pendente gravada) e a resposta enviada.
        await self.store.mark(done_key(job.job_id), settings.job_dedupe_ttl_seconds)
        metrics.observe_ms("processing_duration_ms", (time.monotonic() - started) * 1000)
        metrics.incr("jobs_processed")


def _defer_count(broker_message: BrokerMessage) -> int:
    try:
        return int(broker_message.headers.get(HEADER_DEFER_COUNT, 0) or 0)
    except (TypeError, ValueError):
        return 0
