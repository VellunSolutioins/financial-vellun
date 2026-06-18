"""Histórico recente da conversa para uso como contexto pela IA (Etapa 3).

Consome o endpoint interno ``GET /internal/whatsapp/contacts/:phone/messages``
(Etapa 1). Falhas de rede/resposta vazia não derrubam o fluxo: retornam lista
vazia, e a IA segue apenas com a mensagem atual.
"""

import logging
from urllib.parse import quote

from ..config import settings
from .api_client import api_client

logger = logging.getLogger(__name__)


class ConversationHistoryService:
    async def get_recent_messages(self, phone: str, limit: int = 15) -> list[dict]:
        """Retorna ``[{direction, content, created_at}]`` em ordem cronológica."""
        limit = max(1, min(limit, 50))
        try:
            response = await api_client.get(
                f"/internal/whatsapp/contacts/{quote(phone, safe='')}/messages",
                params={"limit": limit},
            )
        except Exception:  # noqa: BLE001 — histórico é opcional
            logger.warning("Falha ao buscar histórico de %s", phone, exc_info=True)
            return []

        if response.status_code != 200:
            logger.warning(
                "Histórico recusado (%s) para %s", response.status_code, phone
            )
            return []

        data = response.json()
        messages = data.get("messages", []) if isinstance(data, dict) else []

        max_chars = settings.message_max_chars
        result: list[dict] = []
        for msg in messages:
            content = (msg.get("content") or "")[:max_chars]
            result.append(
                {
                    "direction": msg.get("direction"),
                    "content": content,
                    "created_at": msg.get("createdAt"),
                }
            )
        return result


conversation_history_service = ConversationHistoryService()
