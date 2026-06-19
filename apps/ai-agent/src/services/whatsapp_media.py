"""Download de mídia da WhatsApp Cloud API (Meta).

A Meta não envia o conteúdo no webhook — envia um ``media_id``. Para obter os
bytes é preciso (1) resolver a URL temporária via ``GET {base}/{media_id}`` e
(2) baixar o binário dessa URL, ambos com ``Authorization: Bearer <token>``.

Falhas (sem token, rede, tamanho acima do limite) retornam ``None`` — o chamador
responde com uma mensagem de fallback ao usuário.
"""

from __future__ import annotations

import logging

import httpx

from ..config import settings

logger = logging.getLogger(__name__)


class WhatsappMediaClient:
    def __init__(self) -> None:
        self._base_url = settings.whatsapp_api_base_url.rstrip("/")
        self._token = settings.whatsapp_provider_token
        self._max_bytes = settings.media_max_bytes

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            headers={"Authorization": f"Bearer {self._token}"},
            timeout=30.0,
            follow_redirects=True,
        )

    async def fetch(self, media_id: str) -> tuple[bytes, str] | None:
        """Baixa a mídia. Retorna ``(bytes, mime_type)`` ou ``None`` em falha."""
        if not self._token:
            logger.warning("WHATSAPP_PROVIDER_TOKEN ausente; não é possível baixar mídia")
            return None

        try:
            async with self._client() as client:
                meta = await client.get(f"{self._base_url}/{media_id}")
                if meta.status_code != 200:
                    logger.warning("Falha ao resolver mídia (%s): %s", meta.status_code, meta.text)
                    return None
                info = meta.json()
                url = info.get("url")
                mime = info.get("mime_type") or "application/octet-stream"
                if not url:
                    logger.warning("Resposta de mídia sem URL: %s", info)
                    return None

                binary = await client.get(url)
                if binary.status_code != 200:
                    logger.warning("Falha ao baixar mídia (%s)", binary.status_code)
                    return None
                content = binary.content
                if len(content) > self._max_bytes:
                    logger.warning("Mídia acima do limite (%d bytes)", len(content))
                    return None
                return content, mime
        except Exception:  # noqa: BLE001 — falha de rede não derruba o fluxo
            logger.exception("Erro ao baixar mídia %s", media_id)
            return None


whatsapp_media = WhatsappMediaClient()
