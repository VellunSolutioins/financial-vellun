"""Adapter de entrada do webhook do WhatsApp.

Normaliza o corpo recebido para uma lista de :class:`InboundMessage`,
aceitando dois formatos:

- **Simulado (MVP/Postman):** ``{"phone", "message", "message_id?", "timestamp?"}``.
- **Real (WhatsApp Cloud API / Meta):** ``{"object": "whatsapp_business_account",
  "entry": [{"changes": [{"value": {"messages": [...]}}]}]}``.

Cada mensagem é classificada por ``kind`` (``text``/``audio``/``image``/
``unsupported``). Eventos sem mensagem (status de entrega ``statuses[]``)
retornam lista vazia, para o webhook responder ``200`` sem reprocessar.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class InboundMessage:
    """Mensagem inbound já normalizada, pronta para roteamento."""

    phone: str
    message: str = ""
    message_id: str | None = None
    timestamp: int | None = None
    # text | audio | image | unsupported
    kind: str = "text"
    media_id: str | None = None
    media_mime: str | None = None
    caption: str | None = None
    raw_type: str | None = None


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
                item = _parse_meta_message(msg)
                if item is not None:
                    out.append(item)
    return out


def _parse_meta_message(msg: dict) -> InboundMessage | None:
    sender = msg.get("from")
    if not sender:
        return None

    mtype = msg.get("type")
    timestamp = msg.get("timestamp")
    common = {
        "phone": sender,
        "message_id": msg.get("id"),
        "timestamp": int(timestamp) if timestamp is not None else None,
    }

    if mtype == "text":
        body = (msg.get("text") or {}).get("body")
        if not body:
            return None
        return InboundMessage(message=body, kind="text", **common)

    if mtype in ("audio", "voice"):
        media = msg.get(mtype) or {}
        if not media.get("id"):
            return None
        return InboundMessage(
            kind="audio",
            media_id=media.get("id"),
            media_mime=media.get("mime_type"),
            raw_type=mtype,
            **common,
        )

    if mtype == "image":
        media = msg.get("image") or {}
        if not media.get("id"):
            return None
        return InboundMessage(
            kind="image",
            media_id=media.get("id"),
            media_mime=media.get("mime_type"),
            caption=media.get("caption"),
            raw_type=mtype,
            **common,
        )

    # Vídeo, documento, sticker, localização, contato, etc.
    logger.info("Mensagem de tipo não suportado recebida (type=%s)", mtype)
    return InboundMessage(kind="unsupported", raw_type=mtype, **common)
