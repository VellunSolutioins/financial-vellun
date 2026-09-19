"""Consumer de ``whatsapp.inbound.v1``.

Responsabilidades (nesta ordem, porque a ordem define o que pode ser ackado):

1. validar o contrato — inválido é falha permanente, vai direto para a DLQ;
2. persistir a ``AiMessage`` inbound de forma idempotente (a API deduplica por
   ``providerMessageId`` e devolve ``duplicate: true``);
3. baixar e interpretar mídia — **aqui**, nunca no webhook;
4. gravar o conteúdo textual no agrupamento por telefone (ou, para comprovante,
   publicar o job diretamente);
5. só então retornar, o que faz o consumer ackar.

Falha em qualquer etapa levanta exceção: transitória vira retry com backoff,
permanente vai para a DLQ.

**Duplicata na persistência não encerra o fluxo.** Antes ela retornava cedo, e o
retry de uma entrega que falhou entre (2) e (4) — Redis fora, por exemplo —
encontrava a mensagem como duplicata, ackava sem agrupar e a mensagem se perdia
em silêncio; o mesmo caminho tornava o reprocessamento manual um no-op. Agora o
id já persistido é reaproveitado e o agrupamento segue, deduplicando por
``providerMessageId`` dentro do grupo.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from pydantic import ValidationError

from ..grouping import GroupEntry, GroupStore, get_group_store
from ..messaging.base import (
    ROUTE_PROCESSING,
    BrokerMessage,
    MessagePublisher,
    PermanentError,
    TransientError,
)
from ..config import settings
from ..messaging.contracts import (
    RAW_TYPE_TEXT_TOO_LONG,
    InboundMessageV1,
    ProcessingJobV1,
    derive_job_id,
)
from ..observability.logging import log_context
from ..services.audit_service import audit_service
from ..services.contact_service import contact_service
from ..services.media_resolver import (
    UNSUPPORTED_MEDIA_MESSAGE,
    media_resolver,
    text_too_long_message,
)
from ..services.message_processor import NOT_LINKED_MESSAGE, message_processor
from ..services.metrics import metrics
from ..services.subscription_gate import subscription_gate

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PersistedInbound:
    """Resultado de persistir a ``AiMessage`` inbound.

    ``duplicate`` é informativo (métrica e log): o fluxo continua igual, porque a
    duplicata carrega o **mesmo** ``ai_message_id`` e o agrupamento é idempotente.
    """

    ai_message_id: str | None
    duplicate: bool


class InboundMessageConsumer:
    def __init__(
        self, publisher: MessagePublisher, store: GroupStore | None = None
    ) -> None:
        self._publisher = publisher
        self._store = store

    @property
    def store(self) -> GroupStore:
        if self._store is None:
            self._store = get_group_store()
        return self._store

    async def handle(self, broker_message: BrokerMessage) -> None:
        try:
            message = InboundMessageV1.model_validate_json(broker_message.body)
        except ValidationError as exc:
            raise PermanentError(f"contrato inbound inválido: {exc.error_count()} erro(s)") from exc

        with log_context(
            correlation_id=message.correlation_id,
            provider_message_id=message.provider_message_id,
            phone=message.phone,
        ):
            metrics.incr("messages_consumed")
            if message.kind == "unsupported" and message.raw_type == RAW_TYPE_TEXT_TOO_LONG:
                metrics.incr("message_too_long")
                await message_processor.respond(
                    message.phone, text_too_long_message(settings.message_max_chars)
                )
                return
            if message.kind == "unsupported":
                metrics.incr("media_unsupported")
                await message_processor.respond(message.phone, UNSUPPORTED_MEDIA_MESSAGE)
                return
            if message.kind == "text":
                await self._handle_text(message)
                return
            await self._handle_media(message)

    # ── Texto ───────────────────────────────────────────────────────────────
    async def _handle_text(self, message: InboundMessageV1) -> None:
        persisted = await self._persist_inbound(message, message.text or "")

        await self._group(
            message,
            GroupEntry(
                text=message.text or "",
                ai_message_id=persisted.ai_message_id,
                provider_message_id=message.provider_message_id,
                received_at=message.received_at.isoformat(),
                correlation_id=message.correlation_id,
            ),
        )

    # ── Mídia ───────────────────────────────────────────────────────────────
    async def _handle_media(self, message: InboundMessageV1) -> None:
        contact = await contact_service.find_by_phone(message.phone)
        if contact is None:
            metrics.incr("not_linked")
            await message_processor.respond(message.phone, NOT_LINKED_MESSAGE)
            return

        user_id = contact["userId"]
        # Bloqueia antes de baixar/transcrever/visão: são operações pagas.
        allowed, block_message = await subscription_gate.evaluate(user_id)
        if not allowed:
            metrics.incr("subscription_blocked")
            await message_processor.respond(
                message.phone, block_message or NOT_LINKED_MESSAGE
            )
            return

        context = (
            await message_processor._build_context(user_id, contact, message.phone)
            if message.kind == "image"
            else {}
        )
        metrics.incr(f"media_{message.kind}")
        resolution = await media_resolver.resolve(
            kind=message.kind,
            media_id=message.media_id,
            media_mime=message.media_mime,
            caption=message.caption,
            context=context,
        )

        if resolution.fallback_message is not None:
            await message_processor.respond(message.phone, resolution.fallback_message)
            return

        persisted = await self._persist_inbound(message, resolution.log_content)

        if resolution.transcript is not None:
            # Áudio entra no agrupamento como texto, ecoando a transcrição.
            await self._group(
                message,
                GroupEntry(
                    text=resolution.transcript,
                    ai_message_id=persisted.ai_message_id,
                    provider_message_id=message.provider_message_id,
                    received_at=message.received_at.isoformat(),
                    response_prefix=f'Entendi: "{resolution.transcript}".\n',
                    correlation_id=message.correlation_id,
                ),
            )
            return

        # Comprovante: job próprio, com o intent já extraído e confirmação forçada.
        # Republicar é seguro: o ``jobId`` deriva do id persistido, então uma
        # duplicata gera o mesmo job e o consumer de processamento o descarta.
        await self._publish_receipt_job(message, resolution, persisted.ai_message_id)

    async def _publish_receipt_job(
        self, message: InboundMessageV1, resolution, persisted_id: str | None
    ) -> None:
        assert resolution.intent is not None
        source_ids = [persisted_id] if persisted_id else []
        provider_ids = (
            [message.provider_message_id] if message.provider_message_id else []
        )
        job = ProcessingJobV1(
            job_id=derive_job_id(
                phone=message.phone,
                source_message_ids=source_ids,
                provider_message_ids=provider_ids,
            ),
            phone=message.phone,
            combined_message=message.caption or "comprovante (imagem)",
            source_message_ids=source_ids,
            provider_message_ids=provider_ids,
            first_received_at=message.received_at,
            last_received_at=message.received_at,
            correlation_id=message.correlation_id,
            pre_extracted_intent=resolution.intent.model_dump(mode="json"),
            force_confirm=True,
            confirm_question=resolution.confirm_question,
        )
        with log_context(job_id=job.job_id):
            await self._publisher.publish(
                ROUTE_PROCESSING, job, correlation_id=job.correlation_id
            )
            metrics.incr("jobs_published")

    # ── Agrupamento ─────────────────────────────────────────────────────────
    async def _group(self, message: InboundMessageV1, entry: GroupEntry) -> None:
        """Grava a mensagem no agrupamento por telefone.

        O append é idempotente por ``providerMessageId``, então chamar isto para
        uma duplicata é seguro: se a mensagem já está no grupo nada acontece; se
        não está — retry que falhou depois de persistir — ela finalmente entra.
        """
        result = await self.store.append(message.phone, entry)
        if result.added:
            metrics.incr("inbound_grouped")
            return

        metrics.incr("inbound_group_deduplicated")
        logger.info("Mensagem já estava no grupo; agrupamento não duplicou")

    # ── Persistência ────────────────────────────────────────────────────────
    async def _persist_inbound(
        self, message: InboundMessageV1, content: str
    ) -> PersistedInbound:
        """Grava a ``AiMessage`` inbound, de forma idempotente.

        Devolve sempre o id da mensagem (a API responde com o id existente
        quando é duplicata), marcando em ``duplicate`` se já existia. Levanta
        :class:`TransientError` quando a API está indisponível — assim a mensagem
        é reprocessada em vez de ackada sem efeito.
        """
        metadata: dict = {}
        if message.provider_message_id:
            metadata["messageId"] = message.provider_message_id
        if message.provider_timestamp is not None:
            metadata["timestamp"] = int(message.provider_timestamp.timestamp())

        result = await audit_service.log_message_detailed(
            message.phone, "inbound", content, metadata=metadata or None
        )
        if result is None:
            raise TransientError("API principal indisponível ao persistir a inbound")

        duplicate = bool(result.get("duplicate"))
        if duplicate:
            metrics.incr("messages_duplicated")
            logger.info("Inbound já persistida; reaproveitando o id existente")
        return PersistedInbound(ai_message_id=result.get("id"), duplicate=duplicate)
