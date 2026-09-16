import logging
from urllib.parse import quote

from ..messaging.base import TransientError
from .api_client import api_client

logger = logging.getLogger(__name__)


class ContactService:
    """Resolve o usuário vinculado a um número de WhatsApp via API interna."""

    async def find_by_phone(self, phone: str) -> dict | None:
        """Retorna ``{user_id, name, profile_type, is_verified}`` ou ``None``.

        ``None`` significa **só** "número não vinculado" (``404``). Não conseguir
        perguntar — rede, ``5xx``, ``401`` de ``INTERNAL_API_KEY`` divergente —
        levanta :class:`TransientError`. Antes as duas situações devolviam
        ``None`` e o usuário vinculado recebia "seu número não está vinculado"
        durante uma queda da API, em vez de a mensagem ser retentada.
        """
        try:
            response = await api_client.get(
                f"/internal/whatsapp/contacts/{quote(phone, safe='')}"
            )
        except Exception as exc:  # noqa: BLE001 — qualquer falha de transporte
            raise TransientError(
                f"API principal indisponível ao buscar contato: {type(exc).__name__}"
            ) from exc

        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise TransientError(
                f"resposta inesperada ({response.status_code}) ao buscar contato"
            )

        return response.json()


contact_service = ContactService()
