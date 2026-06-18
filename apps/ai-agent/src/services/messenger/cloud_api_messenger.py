"""Messenger de produção via WhatsApp Cloud API (Meta/Graph).

Envia mensagens de texto por ``POST {base}/{phone_number_id}/messages`` com
``Authorization: Bearer <token>``. Falhas de entrega são logadas, não
propagadas, para não derrubar o processamento da mensagem.
"""

import logging

import httpx

from ...config import settings
from .base import Messenger

logger = logging.getLogger(__name__)


class WhatsappCloudApiMessenger(Messenger):
    def __init__(self) -> None:
        if not settings.whatsapp_provider_token:
            raise ValueError("WHATSAPP_PROVIDER_TOKEN não configurado")
        if not settings.whatsapp_phone_number_id:
            raise ValueError("WHATSAPP_PHONE_NUMBER_ID não configurado")
        self._url = (
            f"{settings.whatsapp_api_base_url.rstrip('/')}/"
            f"{settings.whatsapp_phone_number_id}/messages"
        )
        self._client = httpx.AsyncClient(
            headers={
                "Authorization": f"Bearer {settings.whatsapp_provider_token}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    async def send(self, phone: str, text: str) -> None:
        # Cloud API espera o número sem o "+".
        to = phone.lstrip("+")
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "text",
            "text": {"body": text},
        }
        try:
            response = await self._client.post(self._url, json=payload)
        except Exception:  # noqa: BLE001 — falha de rede não derruba o fluxo
            logger.exception("Falha de rede ao enviar mensagem para %s", phone)
            return

        if response.status_code not in (200, 201):
            # Nunca logar o token; apenas status/corpo da resposta da API.
            logger.warning(
                "WhatsApp Cloud API recusou envio (%s): %s",
                response.status_code,
                response.text,
            )

    async def aclose(self) -> None:
        await self._client.aclose()
