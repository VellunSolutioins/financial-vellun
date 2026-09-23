"""Webhook do WhatsApp: verificação (GET) e ingestão (POST).

- ``GET /webhook/whatsapp``: handshake de verificação da Meta — ecoa
  ``hub.challenge`` quando ``hub.verify_token`` confere com
  ``WHATSAPP_VERIFY_TOKEN``.
- ``POST /webhook/whatsapp``: valida a assinatura, normaliza o payload e
  **publica** cada mensagem em ``whatsapp.inbound.v1``. Responde ``202`` apenas
  depois do *publisher confirm* do broker, e ``503`` se não for possível
  garantir a publicação.

O endpoint **não** fala com a API principal, banco, OpenAI, serviços de contato
ou assinatura, e não baixa mídia: tudo isso roda nos consumers. O caminho antigo
(``MESSAGE_PIPELINE=legacy``) segue disponível para rollback.
"""

import asyncio
import hashlib
import hmac
import logging
import time

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from fastapi.responses import PlainTextResponse
from pydantic import ValidationError

from ..bootstrap import pipeline
from ..config import settings
from ..messaging.base import ROUTE_INBOUND, PublishError
from ..messaging.contracts import RAW_TYPE_TEXT_TOO_LONG, InboundMessageV1, new_id
from ..observability.logging import current_context, log_context, safe_phone
from ..services.metrics import metrics
from ..services.phone import normalize_phone
from ..services.whatsapp_inbound import InboundMessage, parse_inbound

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhook", tags=["webhook"])

# Mantém referência às tasks de background do modo legado (evita coleta pelo GC).
_background_tasks: set[asyncio.Task] = set()


def _schedule(coro) -> None:
    """Agenda processamento fora do request. Usado apenas no modo legado."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    def _log_exc(t: asyncio.Task) -> None:
        if not t.cancelled() and t.exception() is not None:
            logger.error("Falha no processamento de mídia em background", exc_info=t.exception())

    task.add_done_callback(_log_exc)


async def _read_limited_body(request: Request, max_bytes: int) -> bytes:
    """Lê o corpo sem passar de ``max_bytes``, antes de validar a assinatura.

    ``request.body()`` carregava o corpo inteiro na memória, qualquer que fosse
    o tamanho, e só então a assinatura era conferida: tráfego não autenticado
    decidia quanta memória o processo alocava. Um ``Content-Length`` declarado
    acima do limite é recusado sem ler nada; sem ele (chunked), a leitura para
    no primeiro pedaço que ultrapassa.
    """
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes:
        metrics.incr("webhook_body_too_large")
        raise HTTPException(status_code=413, detail="Corpo da requisição grande demais")

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            metrics.incr("webhook_body_too_large")
            raise HTTPException(status_code=413, detail="Corpo da requisição grande demais")
        chunks.append(chunk)
    return b"".join(chunks)


def _verify_signature(raw_body: bytes, signature: str | None) -> bool:
    """Valida assinatura HMAC-SHA256.

    A Meta envia ``X-Hub-Signature-256: sha256=<hex>`` calculada sobre o corpo
    bruto com o **App Secret**. Sem secret, recusa — exceto em ambiente local
    com ``WEBHOOK_ALLOW_UNSIGNED=true``, para simular mensagens.
    """
    if not settings.whatsapp_webhook_secret:
        if settings.is_local and settings.webhook_allow_unsigned:
            return True
        logger.error("WHATSAPP_WEBHOOK_SECRET ausente: webhook recusado")
        return False
    if not signature:
        return False
    expected = hmac.new(
        settings.whatsapp_webhook_secret.encode(), raw_body, hashlib.sha256
    ).hexdigest()
    provided = signature.removeprefix("sha256=")
    return hmac.compare_digest(expected, provided)


@router.get("/whatsapp")
async def verify_whatsapp(
    hub_mode: str | None = Query(default=None, alias="hub.mode"),
    hub_challenge: str | None = Query(default=None, alias="hub.challenge"),
    hub_verify_token: str | None = Query(default=None, alias="hub.verify_token"),
) -> PlainTextResponse:
    """Handshake de verificação da Meta: ecoa ``hub.challenge`` se o token bater."""
    expected = settings.whatsapp_verify_token
    if (
        hub_mode == "subscribe"
        and expected
        and hub_verify_token
        and hmac.compare_digest(hub_verify_token, expected)
    ):
        logger.info("Webhook verificado com sucesso pela Meta")
        return PlainTextResponse(content=hub_challenge or "")
    logger.warning("Verificação do webhook falhou (token não confere)")
    raise HTTPException(status_code=403, detail="Verificação inválida")


def to_contract(item: InboundMessage, correlation_id: str) -> InboundMessageV1:
    """Converte a mensagem normalizada no contrato publicado na fila."""
    provider_timestamp = None
    if item.timestamp is not None:
        from datetime import datetime, timezone

        provider_timestamp = datetime.fromtimestamp(item.timestamp, tz=timezone.utc)

    return InboundMessageV1(
        provider_message_id=item.message_id,
        phone=normalize_phone(item.phone),
        kind=item.kind,
        text=item.message or None,
        media_id=item.media_id,
        media_mime=item.media_mime,
        caption=item.caption,
        raw_type=item.raw_type,
        provider_timestamp=provider_timestamp,
        correlation_id=correlation_id,
    )


def _too_long_contract(item: InboundMessage, correlation_id: str) -> InboundMessageV1:
    """Contrato do texto que passou do limite: nao suportado, sem o conteudo."""
    contract = to_contract(item, correlation_id)
    return contract.model_copy(
        update={"kind": "unsupported", "text": None, "raw_type": RAW_TYPE_TEXT_TOO_LONG}
    )


@router.post("/whatsapp")
async def receive_whatsapp(
    response: Response,
    request: Request,
    x_hub_signature_256: str | None = Header(default=None),
    x_webhook_signature: str | None = Header(default=None),
) -> dict:
    started = time.monotonic()
    raw_body = await _read_limited_body(request, settings.webhook_max_body_bytes)

    # `X-Hub-Signature-256` é o header oficial da Meta; mantemos o
    # `X-Webhook-Signature` por compatibilidade com o formato simulado.
    signature = x_hub_signature_256 or x_webhook_signature
    if not _verify_signature(raw_body, signature):
        metrics.incr("webhook_invalid_signature")
        raise HTTPException(status_code=401, detail="Assinatura inválida")

    inbound = parse_inbound(raw_body)
    if not inbound:
        # Status de entrega ou payload sem mensagem: 200 para a Meta não reenviar,
        # e nenhum job financeiro é criado.
        metrics.incr("webhook_ignored")
        return {"status": "ignored"}

    metrics.incr("webhook_received")

    if not settings.is_broker_pipeline:
        await _handle_legacy(inbound)
        metrics.observe_ms("webhook_latency_ms", (time.monotonic() - started) * 1000)
        return {"status": "accepted"}

    # Reaproveita a correlação aberta pelo middleware — que respeita o
    # `x-correlation-id` recebido. Gerar um id aqui faria o mesmo fluxo aparecer
    # no Loki com dois ids: o do chamador e o nosso.
    correlation_id = current_context().correlation_id or new_id()
    messages: list[InboundMessageV1] = []
    for item in inbound:
        try:
            if item.kind == "text" and len(item.message) > settings.message_max_chars:
                # Antes era descartado em silencio: o usuario ficava sem resposta
                # e sem saber que o lancamento nao entrou. Vai para a fila como
                # nao suportado — sem o texto — para o consumer responder.
                metrics.incr("webhook_text_too_long")
                logger.warning("Mensagem muito longa recusada de %s", safe_phone(item.phone))
                messages.append(_too_long_contract(item, correlation_id))
                continue
            messages.append(to_contract(item, correlation_id))
        except ValidationError as exc:
            # Item que nunca vai validar: texto só com espaços (o `parse_inbound`
            # só descarta texto vazio) ou mídia sem `id`. Deixar a exceção subir
            # virava 500, e a Meta reenviaria o lote inteiro para sempre — levando
            # junto as mensagens válidas do mesmo lote. Descartado por item, o
            # resto segue.
            metrics.incr("webhook_invalid_item")
            logger.warning(
                "Item do webhook descartado por contrato inválido (%s, %d erro(s)) de %s",
                item.kind,
                exc.error_count(),
                safe_phone(item.phone),
            )

    if not messages:
        metrics.incr("webhook_ignored")
        return {"status": "ignored"}

    with log_context(correlation_id=correlation_id):
        try:
            publisher = pipeline.require_publisher()
            await publisher.publish_many(
                ROUTE_INBOUND, messages, correlation_id=correlation_id
            )
        except (PublishError, RuntimeError) as exc:
            metrics.incr("publish_failed")
            logger.error("Não foi possível publicar o evento recebido: %s", type(exc).__name__)
            raise HTTPException(
                status_code=503, detail="Serviço temporariamente indisponível"
            ) from exc

        metrics.incr("publish_confirmed", len(messages))
        metrics.observe_ms("webhook_latency_ms", (time.monotonic() - started) * 1000)
        logger.info("%d mensagem(ns) publicada(s) em %s", len(messages), ROUTE_INBOUND)

    response.status_code = 202
    return {"status": "accepted", "published": len(messages)}


async def _handle_legacy(inbound: list[InboundMessage]) -> None:
    """Caminho antigo: buffer em processo + tasks de background."""
    from ..services.media_processor import media_processor
    from ..services.media_resolver import text_too_long_message
    from ..services.message_buffer import message_buffer
    from ..services.message_processor import message_processor

    for item in inbound:
        if item.kind == "text":
            if len(item.message) > settings.message_max_chars:
                metrics.incr("webhook_text_too_long")
                logger.warning("Mensagem muito longa recusada")
                _schedule(
                    message_processor.respond(
                        item.phone, text_too_long_message(settings.message_max_chars)
                    )
                )
                continue
            await message_buffer.add(
                item.phone,
                item.message,
                provider_message_id=item.message_id,
                provider_timestamp=item.timestamp,
            )
        elif item.kind in ("audio", "image"):
            _schedule(media_processor.process(item.phone, item))
        else:  # unsupported
            _schedule(media_processor.respond_unsupported(item.phone))
