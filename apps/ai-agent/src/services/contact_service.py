import logging
from urllib.parse import quote

from .api_client import api_client

logger = logging.getLogger(__name__)


class ContactService:
    """Resolve o usuário vinculado a um número de WhatsApp via API interna."""

    async def find_by_phone(self, phone: str) -> dict | None:
        """Retorna ``{user_id, name, profile_type, is_verified}`` ou ``None``."""
        try:
            response = await api_client.get(
                f"/internal/whatsapp/contacts/{quote(phone, safe='')}"
            )
        except Exception:  # noqa: BLE001 — rede indisponível não deve derrubar o webhook
            logger.exception("Falha ao consultar contato %s", phone)
            return None

        if response.status_code == 404:
            return None
        if response.status_code != 200:
            logger.warning(
                "Resposta inesperada (%s) ao buscar contato %s", response.status_code, phone
            )
            return None

        return response.json()


contact_service = ContactService()
