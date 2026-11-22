"""Feature flags globais (painel /ops), lidas da API principal.

As ações novas do agente (docs/plans/018) ficam atrás de flags. A rota de cada
ação já recusa com a flag desligada; aqui o agente só consulta o estado para
montar a ajuda com o que está ligado. Sem resposta da API, tudo conta como
desligado: a ajuda nunca promete uma ação que pode não funcionar.
"""

from __future__ import annotations

import logging

from .api_client import api_client

logger = logging.getLogger(__name__)


class FeatureFlags:
    async def enabled(self) -> dict[str, bool]:
        """Estado de todas as flags; ``{}`` se não deu para consultar."""
        try:
            response = await api_client.get("/internal/features")
        except Exception:  # noqa: BLE001 — a ajuda segue sem as ações novas
            logger.warning("Não consegui consultar as feature flags", exc_info=True)
            return {}
        if response.status_code != 200:
            logger.warning("Feature flags responderam %s", response.status_code)
            return {}
        body = response.json()
        return {key: bool(value) for key, value in body.items()} if isinstance(body, dict) else {}


feature_flags = FeatureFlags()
