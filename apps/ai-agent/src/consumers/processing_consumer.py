"""Consumer de ``whatsapp.processing.v1``.

Executa o fluxo que antes começava no ``MessageProcessor``: contato →
assinatura → contexto → confirmação pendente → IA → lançamento → resposta →
outbound.

Garantias:

- **idempotência** — o ``jobId`` é determinístico e fica marcado como concluído;
  uma reentrega depois do ack não reprocessa, e o mesmo ``jobId`` vira a chave
  de idempotência do lançamento na API;
- **ordenação por telefone** — lock distribuído **com dono** durante todo o
  processamento, **renovado** enquanto o job roda. Um job cujo telefone está
  ocupado é adiado (sem consumir tentativa), então a confirmação nunca é
  processada antes da pergunta;
- **concorrência limitada** — o número de jobs simultâneos vem de
  ``PROCESSING_CONSUMER_CONCURRENCY`` (o semáforo vive no consumer do broker);
- **entrega retentável sem reprocessar** — a resposta calculada é guardada antes
  de ser enviada. Se só o envio falhar, o retry reenvia esse texto: refazer o job
  repetiria efeitos que não são idempotentes (a confirmação pendente já foi
  consumida). O job só é marcado como concluído **depois** da entrega.
"""

from __future__ import annotations

import asyncio
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


def reply_key(job_id: str) -> str:
    return f"job:reply:{job_id}"


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

            chave = lock_key(job.phone)
            ttl = settings.processing_lock_ttl_seconds
            token = await self.store.acquire(chave, ttl)
            if token is None:
                defers = _defer_count(broker_message)
                if defers >= MAX_DEFERS:
                    raise RuntimeError(
                        "telefone travado por tempo excessivo; tratando como falha"
                    )
                metrics.incr("jobs_deferred")
                raise DeferError("telefone já em processamento por outro worker")

            renovacao = asyncio.create_task(self._manter_lock(chave, token, ttl))
            try:
                await self._process(job)
            finally:
                renovacao.cancel()
                # `gather` com `return_exceptions` recolhe o cancelamento da
                # renovação sem engolir um cancelamento do próprio `handle`.
                await asyncio.gather(renovacao, return_exceptions=True)
                if not await self.store.release(chave, token):
                    # O lock expirou e passou a outro worker antes daqui. Antes,
                    # o release apagava o lock desse outro, abrindo a porta para
                    # um terceiro processar o mesmo telefone em paralelo.
                    metrics.incr("processing_lock_lost")
                    logger.warning("Lock do telefone já não era deste worker ao liberar")

    async def _manter_lock(self, chave: str, token: str, ttl: int) -> None:
        """Renova o lock a cada terço do TTL enquanto o job roda.

        Sem renovação, um processamento acima do TTL (uma chamada lenta à IA,
        por exemplo) perdia o lock no meio, e o próximo job do mesmo telefone
        entrava em paralelo — a confirmação podia ser tratada antes da pergunta.
        """
        intervalo = max(ttl / 3, 1.0)
        while True:
            await asyncio.sleep(intervalo)
            try:
                if not await self.store.extend(chave, token, ttl):
                    # Perdido: outro worker já pode ter entrado. Não há como
                    # recuperar com segurança; o que resta é deixar rastro.
                    metrics.incr("processing_lock_lost")
                    logger.warning(
                        "Lock do telefone perdido durante o processamento; "
                        "a ordem deste telefone pode não estar garantida"
                    )
                    return
            except Exception:  # noqa: BLE001 - renovar não pode derrubar o job
                logger.warning("Falha ao renovar o lock do telefone", exc_info=True)

    async def _process(self, job: ProcessingJobV1) -> None:
        started = time.monotonic()
        metrics.observe_ms(
            "receive_to_process_ms",
            max((utcnow() - job.first_received_at).total_seconds() * 1000, 0.0),
        )

        chave_resposta = reply_key(job.job_id)
        reply = await self.store.get(chave_resposta)
        if reply is None:
            reply = await message_processor.process_job(job)
            await self.store.put(chave_resposta, reply, settings.job_dedupe_ttl_seconds)
        else:
            metrics.incr("jobs_reply_resumed")
            logger.info("Resposta já calculada numa tentativa anterior; só reenviando")

        if reply:
            await message_processor.deliver(job.phone, reply)

        # Só marca como concluído depois que o estado final está persistido
        # (lançamento criado ou confirmação pendente gravada) e a resposta entregue.
        await self.store.mark(done_key(job.job_id), settings.job_dedupe_ttl_seconds)
        await self.store.forget(chave_resposta)
        metrics.observe_ms("processing_duration_ms", (time.monotonic() - started) * 1000)
        metrics.incr("jobs_processed")


def _defer_count(broker_message: BrokerMessage) -> int:
    try:
        return int(broker_message.headers.get(HEADER_DEFER_COUNT, 0) or 0)
    except (TypeError, ValueError):
        return 0
