"""Health checks separados para liveness e readiness.

- ``/health/live``  — o processo esta de pe (nunca depende de dependencia externa);
- ``/health/ready`` — o pipeline consegue publicar e consumir. Falha com ``503``
  quando o broker ou o Redis estao fora, para o orquestrador tirar a instancia
  do balanceador em vez de aceitar webhooks que nao poderiam ser publicados.
- ``/health``       — alias de liveness, mantido por compatibilidade.
"""

from fastapi import APIRouter, Response

from ..bootstrap import pipeline
from ..config import settings

router = APIRouter(tags=["health"])


@router.get("/health")
async def health_check() -> dict:
    return {"status": "ok"}


@router.get("/health/live")
async def liveness() -> dict:
    return {"status": "ok"}


@router.get("/health/ready")
async def readiness(response: Response) -> dict:
    if not settings.is_broker_pipeline:
        return {"status": "ok", "pipeline": "legacy"}

    ready, details = await pipeline.readiness()
    if not ready:
        response.status_code = 503
    return {"status": "ok" if ready else "unavailable", "pipeline": "broker", **details}
