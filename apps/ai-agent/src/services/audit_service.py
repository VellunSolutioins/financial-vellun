"""Auditoria das operações do agente de IA (P3.7, §9.5).

Persiste mensagens e extrações via `POST /internal/ai-events`.
"""

import logging

from .api_client import api_client

logger = logging.getLogger(__name__)


class AuditService:
    async def log_message(
        self,
        phone: str,
        direction: str,
        content: str,
        metadata: dict | None = None,
    ) -> str | None:
        """Registra uma mensagem (inbound/outbound). Retorna o id da mensagem."""
        payload = {
            "eventType": "message",
            "phone": phone,
            "direction": direction,
            "content": content,
            "metadata": metadata or {},
        }
        result = await self._post(payload)
        return result.get("id") if result else None

    async def log_message_detailed(
        self,
        phone: str,
        direction: str,
        content: str,
        metadata: dict | None = None,
    ) -> dict | None:
        """Como :meth:`log_message`, mas retorna o resultado completo da API
        (``{id, conversationId, duplicate?}``) para suportar idempotência."""
        payload = {
            "eventType": "message",
            "phone": phone,
            "direction": direction,
            "content": content,
            "metadata": metadata or {},
        }
        return await self._post(payload)

    async def log_extraction(
        self,
        user_id: str,
        raw_input: str,
        extracted_payload: dict,
        confidence: float,
        status: str,
        transaction_id: str | None = None,
        source_message_id: str | None = None,
    ) -> str | None:
        """Registra uma extração de IA. Retorna o id do registro."""
        payload = {
            "eventType": "extraction",
            "userId": user_id,
            "rawInput": raw_input,
            "extractedPayload": extracted_payload,
            "confidence": confidence,
            "status": status,
            "transactionId": transaction_id,
            "sourceMessageId": source_message_id,
        }
        result = await self._post(payload)
        return result.get("id") if result else None

    async def _post(self, payload: dict) -> dict | None:
        try:
            response = await api_client.post("/internal/ai-events", json=payload)
        except Exception:  # noqa: BLE001 — auditoria não pode derrubar o fluxo
            logger.exception("Falha ao registrar evento de auditoria")
            return None

        if response.status_code not in (200, 201):
            logger.warning("ai-events recusado (%s): %s", response.status_code, response.text)
            return None
        return response.json()


audit_service = AuditService()
