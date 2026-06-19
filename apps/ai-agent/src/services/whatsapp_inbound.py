"""Adapter de entrada do webhook do WhatsApp.

Normaliza o corpo recebido para uma lista de :class:`InboundMessage`,
aceitando dois formatos:

- **Simulado (MVP/Postman):** ``{"phone", "message", "message_id?", "timestamp?"}``.
- **Real (WhatsApp Cloud API / Meta):** ``{"object": "whatsapp_business_account",
  "entry": [{"changes": [{"value": {"messages": [...]}}]}]}``.

Eventos que não são mensagens de texto (status de entrega ``statuses[]``,
mídia, etc.) são ignorados — retornam lista vazia, para o webhook responder
``200`` sem reprocessar.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class InboundMessage:
    """Mensagem inbound já normalizada, pronta para o buffer."""

    phone: str
    message: str
    message_id: str | None = None
    timestamp: int | None = None


def parse_inbound(raw_body: bytes) -> list[InboundMessage]:
    """Converte o corpo do webhook em mensagens, qualquer que seja o formato."""
    try:
        data = json.loads(raw_body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        logger.warning("Corpo do webhook não é JSON válido")
        return []

    if not isinstance(data, dict):
        return []

    # Formato real da Meta (tem `object`/`entry`).
    if data.get("object") == "whatsapp_business_account" or "entry" in data:
        return _parse_meta(data)

    # Formato simulado (MVP/Postman).
    phone = data.get("phone")
    message = data.get("message")
    if isinstance(phone, str) and isinstance(message, str):
        return [
            InboundMessage(
                phone=phone,
                message=message,
                message_id=data.get("message_id"),
                timestamp=data.get("timestamp"),
            )
        ]
    return []


def _parse_meta(data: dict) -> list[InboundMessage]:
    out: list[InboundMessage] = []
    for entry in data.get("entry") or []:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            for msg in value.get("messages") or []:
                if msg.get("type") != "text":
                    # Áudio/imagem/documento/etc. ainda não suportados.
                    logger.info("Mensagem não-texto ignorada (type=%s)", msg.get("type"))
                    continue
                body = (msg.get("text") or {}).get("body")
                sender = msg.get("from")
                if not body or not sender:
                    continue
                timestamp = msg.get("timestamp")
                out.append(
                    InboundMessage(
                        phone=sender,
                        message=body,
                        message_id=msg.get("id"),
                        timestamp=int(timestamp) if timestamp is not None else None,
                    )
                )
    return out
