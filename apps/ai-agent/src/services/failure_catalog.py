"""Cliente do catalogo de falhas (`POST /internal/ops/failed-messages`).

O agente nao fala com o Postgres — toda persistencia passa pela API principal,
como ja acontece com `ai-events`. Este modulo e a fina camada que traduz o
envelope da DLQ para o contrato do endpoint.

Devolver ``None`` significa **nao confirmado**, e o chamador precisa tratar isso
devolvendo a mensagem a fila. Diferente da auditoria, que e best-effort e pode
sumir sem consequencia, uma falha nao catalogada e uma falha invisivel.
"""

from __future__ import annotations

import logging
from typing import Any

from .api_client import api_client

logger = logging.getLogger(__name__)


class FailureCatalog:
    async def capture(
        self,
        *,
        source: str,
        source_queue: str,
        routing_key: str,
        correlation_id: str | None,
        attempts: int,
        error_type: str,
        error_message: str,
        permanent: bool,
        payload: Any,
        first_failed_at: str | None,
        failed_at: str,
    ) -> dict | None:
        """Registra a falha. Devolve ``{id, duplicate}`` ou ``None`` se falhou."""
        corpo: dict[str, Any] = {
            "source": source,
            "sourceQueue": source_queue,
            "routingKey": routing_key,
            "attempts": attempts,
            "errorType": error_type,
            "errorMessage": error_message,
            "permanent": permanent,
            # O endpoint espera um objeto. Um payload que nao seja dict (uma lista
            # ou uma string solta, vindo de mensagem malformada) e embrulhado para
            # nao ser recusado na validacao e acabar em loop na fila.
            "payload": payload if isinstance(payload, dict) else {"raw": payload},
            "failedAt": failed_at,
        }
        if correlation_id:
            corpo["correlationId"] = correlation_id
        if first_failed_at:
            corpo["firstFailedAt"] = first_failed_at

        try:
            resposta = await api_client.post("/internal/ops/failed-messages", json=corpo)
        except Exception:  # noqa: BLE001 - a decisao de retry e do chamador
            logger.exception("Falha ao chamar o catalogo de falhas")
            return None

        if resposta.status_code not in (200, 201):
            logger.warning(
                "Catalogo de falhas recusou (%s): %s",
                resposta.status_code,
                resposta.text[:200],
            )
            return None
        return resposta.json()


failure_catalog = FailureCatalog()
