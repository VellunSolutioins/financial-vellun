"""Download de mídia da WhatsApp Cloud API (Meta).

A Meta não envia o conteúdo no webhook — envia um ``media_id``. Para obter os
bytes é preciso (1) resolver a URL temporária via ``GET {base}/{media_id}`` e
(2) baixar o binário dessa URL, ambos com ``Authorization: Bearer <token>``.

Falhas (sem token, rede, tamanho acima do limite) retornam ``None`` — o chamador
responde com uma mensagem de fallback ao usuário.

Limites (plano de segurança, S2): o binário é lido **por streaming** e o
download é interrompido ao passar de ``MEDIA_MAX_BYTES`` — antes o arquivo
inteiro ia para a memória e só depois era comparado ao limite. A URL de download
e cada redirecionamento precisam apontar para um host da Meta, e o token só vai
para o host da própria API.
"""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

#: Domínios de onde a Meta serve mídia (o host exato varia por região/CDN).
_META_MEDIA_SUFFIXES = ("fbsbx.com", "facebook.com", "fbcdn.net", "whatsapp.net")
_MAX_REDIRECTS = 3
_REDIRECT_STATUSES = {301, 302, 303, 307, 308}


class MediaTooLarge(Exception):
    """O binário passou de ``media_max_bytes`` durante o download."""


class WhatsappMediaClient:
    def __init__(self) -> None:
        self._base_url = settings.whatsapp_api_base_url.rstrip("/")
        self._api_host = urlsplit(self._base_url).hostname or ""
        self._token = settings.whatsapp_provider_token
        self._max_bytes = settings.media_max_bytes
        self._client: httpx.AsyncClient | None = None

    def _http(self) -> httpx.AsyncClient:
        """Client único, reaproveitando conexões; recriado se tiver sido fechado."""
        if self._client is None or self._client.is_closed:
            # Redirecionamento manual: cada destino é validado antes do request.
            self._client = httpx.AsyncClient(timeout=30.0, follow_redirects=False)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    def _allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        if not host:
            return False
        if host == self._api_host:
            return True
        if parts.scheme != "https":
            return False
        return any(host == s or host.endswith(f".{s}") for s in _META_MEDIA_SUFFIXES)

    def _headers(self, url: str) -> dict[str, str]:
        # O token é da conta do WhatsApp: vai para a API e para a CDN da Meta,
        # nunca para um host que não seja dela.
        return {"Authorization": f"Bearer {self._token}"} if self._allowed(url) else {}

    async def fetch(self, media_id: str) -> tuple[bytes, str] | None:
        """Baixa a mídia. Retorna ``(bytes, mime_type)`` ou ``None`` em falha."""
        if not self._token:
            logger.warning("WHATSAPP_PROVIDER_TOKEN ausente; não é possível baixar mídia")
            return None

        try:
            client = self._http()
            meta_url = f"{self._base_url}/{media_id}"
            meta = await client.get(meta_url, headers=self._headers(meta_url))
            if meta.status_code != 200:
                # Sem o corpo: a resposta da Graph API pode ecoar dados da conta.
                logger.warning("Falha ao resolver mídia (HTTP %s)", meta.status_code)
                return None
            info = meta.json()
            url = info.get("url")
            mime = info.get("mime_type") or "application/octet-stream"
            if not url:
                logger.warning("Resposta de mídia sem URL")
                return None

            content = await self._download(client, url)
            if content is None:
                return None
            return content, mime
        except MediaTooLarge:
            logger.warning("Mídia acima do limite de %d bytes; download interrompido", self._max_bytes)
            return None
        except Exception:  # noqa: BLE001 — falha de rede não derruba o fluxo
            logger.exception("Erro ao baixar mídia %s", media_id)
            return None

    async def _download(self, client: httpx.AsyncClient, url: str) -> bytes | None:
        for _ in range(_MAX_REDIRECTS + 1):
            if not self._allowed(url):
                logger.warning("Download de mídia recusado: host fora da Meta (%s)", urlsplit(url).hostname)
                return None
            async with client.stream("GET", url, headers=self._headers(url)) as response:
                if response.status_code in _REDIRECT_STATUSES:
                    location = response.headers.get("location")
                    if not location:
                        return None
                    url = str(response.url.join(location))
                    continue
                if response.status_code != 200:
                    logger.warning("Falha ao baixar mídia (HTTP %s)", response.status_code)
                    return None
                return await self._read_limited(response)
        logger.warning("Download de mídia com redirecionamentos demais")
        return None

    async def _read_limited(self, response: httpx.Response) -> bytes:
        declared = response.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > self._max_bytes:
            raise MediaTooLarge()
        chunks: list[bytes] = []
        total = 0
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > self._max_bytes:
                raise MediaTooLarge()
            chunks.append(chunk)
        return b"".join(chunks)


whatsapp_media = WhatsappMediaClient()
