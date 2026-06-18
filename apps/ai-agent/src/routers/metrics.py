from fastapi import APIRouter

from ..services.metrics import metrics

router = APIRouter(tags=["metrics"])


@router.get("/metrics")
async def get_metrics() -> dict:
    """Snapshot das métricas do agente (contadores + latências médias)."""
    return metrics.snapshot()
