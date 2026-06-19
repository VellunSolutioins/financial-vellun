"""Webhook do WhatsApp: verificação (GET) e ingestão rápida (POST).

- ``GET /webhook/whatsapp``: handshake de verificação da Meta — ecoa
  ``hub.challenge`` quando ``hub.verify_token`` confere com
  ``WHATSAPP_VERIFY_TOKEN``.
- ``POST /webhook/whatsapp``: valida assinatura, **bufferiza** a(s) mensagem(ns)
  e responde de imediato. Aceita o formato simulado (MVP/Postman) e o real da
  WhatsApp Cloud API. A interpretação de IA e a criação do lançamento acontecem
  de forma assíncrona (ver ``message_buffer`` → ``message_processor``).
"""

import hashlib
import hmac
import logging

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse

from ..config import settings
from ..services.message_buffer import message_buffer
from ..services.metrics import metrics
from ..services.whatsapp_inbound import parse_inbound

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhook", tags=["webhook"])


def _verify_signature(raw_body: bytes, signature: str | None) -> bool:
    """Valida assinatura HMAC-SHA256.

    A Meta envia ``X-Hub-Signature-256: sha256=<hex>`` calculada sobre o corpo
    bruto com o **App Secret**. Sem secret configurado, aceita (dev/simulado).
    """
    if not settings.whatsapp_webhook_secret:
        if settings.is_production:
            # Em produção o secret é obrigatório (§13/Etapa 5).
            logger.error("WHATSAPP_WEBHOOK_SECRET ausente em produção")
            return False
        return True
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


@router.post("/whatsapp")
async def receive_whatsapp(
    request: Request,
    x_hub_signature_256: str | None = Header(default=None),
    x_webhook_signature: str | None = Header(default=None),
) -> dict:
    raw_body = await request.body()

    # `X-Hub-Signature-256` é o header oficial da Meta; mantemos o
    # `X-Webhook-Signature` por compatibilidade com o formato simulado.
    signature = x_hub_signature_256 or x_webhook_signature
    if not _verify_signature(raw_body, signature):
        raise HTTPException(status_code=401, detail="Assinatura inválida")

    inbound = parse_inbound(raw_body)
    if not inbound:
        # Status de entrega, mídia não suportada ou payload sem mensagem:
        # responder 200 para a Meta não reenviar.
        return {"status": "ignored"}

    metrics.incr("webhook_received")

    for item in inbound:
        if len(item.message) > settings.message_max_chars:
            logger.warning("Mensagem muito longa ignorada de %s", item.phone)
            continue
        logger.info("Webhook recebido de %s (message_id=%s)", item.phone, item.message_id)
        await message_buffer.add(
            item.phone,
            item.message,
            provider_message_id=item.message_id,
            provider_timestamp=item.timestamp,
        )

    return {"status": "accepted"}
