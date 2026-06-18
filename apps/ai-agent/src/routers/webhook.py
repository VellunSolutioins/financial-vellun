"""Webhook do WhatsApp: ingestão rápida.

O endpoint apenas valida assinatura/payload, **bufferiza** a mensagem e
responde de imediato (`accepted`). A interpretação de IA e a criação do
lançamento acontecem de forma assíncrona, fora do request (ver
``message_buffer`` → ``message_processor``).
"""

import hashlib
import hmac
import logging

from fastapi import APIRouter, Header, HTTPException, Request

from ..config import settings
from ..schemas.webhook import WhatsappWebhookPayload
from ..services.message_buffer import message_buffer
from ..services.metrics import metrics

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhook", tags=["webhook"])


def _verify_signature(raw_body: bytes, signature: str | None) -> bool:
    """Valida assinatura HMAC-SHA256. Sem secret configurado, aceita (dev)."""
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


@router.post("/whatsapp")
async def receive_whatsapp(
    request: Request,
    x_webhook_signature: str | None = Header(default=None),
) -> dict:
    raw_body = await request.body()
    if not _verify_signature(raw_body, x_webhook_signature):
        raise HTTPException(status_code=401, detail="Assinatura inválida")

    try:
        payload = WhatsappWebhookPayload.model_validate_json(raw_body)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Payload inválido") from exc

    if len(payload.message) > settings.message_max_chars:
        raise HTTPException(status_code=413, detail="Mensagem muito longa")

    metrics.incr("webhook_received")
    logger.info("Webhook recebido de %s (message_id=%s)", payload.phone, payload.message_id)

    await message_buffer.add(
        payload.phone,
        payload.message,
        provider_message_id=payload.message_id,
        provider_timestamp=payload.timestamp,
    )

    return {"status": "accepted"}
