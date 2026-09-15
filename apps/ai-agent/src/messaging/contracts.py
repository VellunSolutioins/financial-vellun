"""Contratos versionados das mensagens trocadas pelo broker.

Todos os payloads são serializados em JSON com chaves ``camelCase`` (aliases) e
carregam ``schemaVersion``. São validados **antes** da publicação e novamente no
consumer: um payload que não valida é falha permanente e vai direto para a DLQ.

Nenhum contrato transporta binário — mídia viaja apenas como referência
(``mediaId``/``mediaMime``), a ser baixada pelo consumer.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = 1

#: Namespace determinístico para derivar ``jobId`` a partir das mensagens de
#: origem — o mesmo conjunto de ids sempre produz o mesmo job (idempotência).
JOB_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "financial-vellun/whatsapp/processing-job")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return str(uuid.uuid4())


class _VersionedMessage(BaseModel):
    """Base dos contratos: aliases camelCase e versão obrigatória."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    schema_version: Literal[1] = Field(default=SCHEMA_VERSION, alias="schemaVersion")

    def to_json(self) -> str:
        return self.model_dump_json(by_alias=True)


#: ``rawType`` de um texto recusado por passar de ``message_max_chars``. Vai como
#: ``kind="unsupported"`` e sem o texto: o consumer responde ao usuario, e a fila
#: nao carrega um conteudo que nunca sera processado.
RAW_TYPE_TEXT_TOO_LONG = "text_too_long"


class InboundMessageV1(_VersionedMessage):
    """Uma mensagem individual recebida no webhook, já normalizada."""

    event_id: str = Field(default_factory=new_id, alias="eventId")
    provider: str = "whatsapp-cloud-api"
    provider_message_id: str | None = Field(default=None, alias="providerMessageId")
    phone: str = Field(min_length=1)
    kind: Literal["text", "audio", "image", "unsupported"] = "text"
    text: str | None = None
    media_id: str | None = Field(default=None, alias="mediaId")
    media_mime: str | None = Field(default=None, alias="mediaMime")
    caption: str | None = None
    raw_type: str | None = Field(default=None, alias="rawType")
    provider_timestamp: datetime | None = Field(default=None, alias="providerTimestamp")
    received_at: datetime = Field(default_factory=utcnow, alias="receivedAt")
    correlation_id: str = Field(default_factory=new_id, alias="correlationId")

    @model_validator(mode="after")
    def _check_kind_payload(self) -> InboundMessageV1:
        if self.kind == "text" and not (self.text or "").strip():
            raise ValueError("mensagem de texto sem conteúdo")
        if self.kind in ("audio", "image") and not self.media_id:
            raise ValueError(f"mensagem de {self.kind} sem mediaId")
        return self


class ProcessingJobV1(_VersionedMessage):
    """Mensagens já consolidadas por telefone, prontas para classificação.

    ``responsePrefix``, ``preExtractedIntent``, ``forceConfirm`` e
    ``confirmQuestion`` preservam o comportamento de mídia: áudio ecoa a
    transcrição na resposta e comprovante (imagem) chega com o intent já extraído
    por visão e sempre pede confirmação.
    """

    job_id: str = Field(alias="jobId")
    phone: str = Field(min_length=1)
    combined_message: str = Field(alias="combinedMessage")
    source_message_ids: list[str] = Field(default_factory=list, alias="sourceMessageIds")
    provider_message_ids: list[str] = Field(default_factory=list, alias="providerMessageIds")
    first_received_at: datetime = Field(default_factory=utcnow, alias="firstReceivedAt")
    last_received_at: datetime = Field(default_factory=utcnow, alias="lastReceivedAt")
    correlation_id: str = Field(default_factory=new_id, alias="correlationId")
    attempt: int = Field(default=0, ge=0)
    response_prefix: str = Field(default="", alias="responsePrefix")
    pre_extracted_intent: dict[str, Any] | None = Field(default=None, alias="preExtractedIntent")
    force_confirm: bool = Field(default=False, alias="forceConfirm")
    confirm_question: str | None = Field(default=None, alias="confirmQuestion")

    @model_validator(mode="after")
    def _check_content(self) -> ProcessingJobV1:
        if not self.combined_message.strip() and self.pre_extracted_intent is None:
            raise ValueError("job sem mensagem e sem intent pré-extraído")
        return self


class DlqEnvelopeV1(_VersionedMessage):
    """Envelope gravado na DLQ, com o necessário para diagnóstico e reprocesso."""

    payload: Any
    source_queue: str = Field(alias="sourceQueue")
    routing_key: str = Field(alias="routingKey")
    attempts: int
    error_type: str = Field(alias="errorType")
    error_message: str = Field(alias="errorMessage")
    permanent: bool = False
    first_failed_at: datetime | None = Field(default=None, alias="firstFailedAt")
    failed_at: datetime = Field(default_factory=utcnow, alias="failedAt")
    correlation_id: str | None = Field(default=None, alias="correlationId")


def derive_job_id(
    *,
    phone: str,
    source_message_ids: list[str],
    provider_message_ids: list[str] | None = None,
) -> str:
    """Deriva um ``jobId`` determinístico do conjunto de mensagens de origem.

    O mesmo grupo (mesmos ids) sempre gera o mesmo job, então uma republicação
    após crash entre o *publisher confirm* e a limpeza do buffer não cria um
    segundo job. Sem ids persistidos (API indisponível), cai nos ids do provedor;
    sem nenhum dos dois, gera um id aleatório — pior caso, o job é único.
    """
    seed = sorted(i for i in source_message_ids if i)
    if not seed:
        seed = sorted(i for i in (provider_message_ids or []) if i)
    if not seed:
        return new_id()
    return str(uuid.uuid5(JOB_NAMESPACE, f"{phone}|" + "|".join(seed)))
