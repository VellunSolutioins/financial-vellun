"""Endpoints internos consumidos pela API principal (server-to-server).

Autenticados pela mesma ``INTERNAL_API_KEY`` compartilhada entre API e agente
(header ``x-internal-api-key``). Não expostos ao WhatsApp/Internet pública.
"""

import hmac
import logging

from fastapi import APIRouter, Header, HTTPException

from ..config import settings
from ..schemas.notifications import WelcomeNotification
from ..services.welcome_service import welcome_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal", tags=["internal"])


def _require_internal_key(x_internal_api_key: str | None = Header(default=None)) -> None:
    """Valida a chave interna em tempo constante (evita timing attacks)."""
    expected = settings.internal_api_key
    if not x_internal_api_key or not hmac.compare_digest(x_internal_api_key, expected):
        raise HTTPException(status_code=401, detail="Chave de API interna inválida")


@router.post("/notifications/welcome")
async def send_welcome(payload: WelcomeNotification, x_internal_api_key: str | None = Header(default=None)) -> dict:
    _require_internal_key(x_internal_api_key)
    if not payload.phone:
        raise HTTPException(status_code=400, detail="phone é obrigatório")
    await welcome_service.send_welcome(payload.phone, payload.name)
    return {"status": "sent"}
