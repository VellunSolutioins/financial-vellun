"""Exposição de métricas do agente.

Duas rotas, e a diferença entre elas é o ponto:

- ``GET /metrics``      texto Prometheus, coletado pelo Alloy;
- ``GET /metrics.json`` o shape antigo (``{counters, timings}``).

O ``/metrics.json`` existe porque a rota ``/metrics`` **mudou de formato** e há
consumidores reais: ``scripts/monitor.py`` e ``scripts/loadtest.py``. Trocar o
formato sem deixar o antigo em algum lugar quebraria as duas ferramentas usadas
justamente para validar carga — e o momento em que se descobre isso é o pior
possível.
"""

from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Header, HTTPException, Response, status

from ..config import settings
from ..services.metrics import metrics

logger = logging.getLogger(__name__)

router = APIRouter(tags=["metrics"])


def require_metrics_token(authorization: str | None) -> None:
    """Exige ``Authorization: Bearer ${METRICS_TOKEN}``.

    Sem token configurado, libera em desenvolvimento e **recusa em produção**. A
    assimetria é deliberada: exigir token no dev local só atrapalharia, e abrir o
    endpoint em produção por variável esquecida expõe nome de rota e volume de
    negócio a quem alcançar a porta.
    """
    expected = (settings.metrics_token or "").strip()

    if not expected:
        if settings.is_production:
            logger.error("METRICS_TOKEN não configurado; /metrics está fechado.")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Coleta de métricas não configurada.",
            )
        return

    prefix = "Bearer "
    provided = (
        authorization[len(prefix) :]
        if authorization and authorization.startswith(prefix)
        else ""
    )
    # `compare_digest` para não vazar o tamanho do token por tempo de resposta.
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token de métricas inválido.",
        )


@router.get("/metrics")
async def prometheus_metrics(authorization: str | None = Header(default=None)) -> Response:
    """Métricas em formato Prometheus."""
    require_metrics_token(authorization)

    body, content_type = metrics.render()
    return Response(content=body, media_type=content_type)


@router.get("/metrics.json")
async def metrics_json(authorization: str | None = Header(default=None)) -> dict:
    """Snapshot no shape legado (contadores + latências médias em ms)."""
    require_metrics_token(authorization)

    return metrics.snapshot()
