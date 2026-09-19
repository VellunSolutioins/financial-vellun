"""Servidor HTTP mínimo do worker, só para observabilidade.

O worker (``python -m src.worker``) não serve HTTP — ele consome filas. Sem um
endpoint, as réplicas de consumo ficam **invisíveis** para o scrape e para o
orquestrador: justamente onde o trabalho acontece, e onde uma parada silenciosa
custa mais. É exatamente o cenário do alerta "fila com mensagem e zero
consumidores": o alerta existiria, mas não haveria o que comparar.

Expõe apenas:

- ``/metrics``      as mesmas métricas Prometheus da API do agente;
- ``/health/live``  o processo está de pé;
- ``/health/ready`` o pipeline consegue publicar e consumir (o mesmo
  ``pipeline.readiness()`` que a API usa).

É um ``uvicorn`` sobre uma app ASGI escrita à mão, sem FastAPI: são três rotas e
nenhuma validação de corpo, então o roteador do FastAPI seria peso morto num
processo cujo trabalho é consumir fila.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import HTTPException

from ..config import settings
from ..routers.metrics import require_metrics_token
from ..services.metrics import metrics

logger = logging.getLogger(__name__)


async def _send_json(send, status: int, payload: dict) -> None:
    body = json.dumps(payload).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def _send_text(send, status: int, body: bytes, content_type: str) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", content_type.encode()),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


def _authorization(scope) -> str | None:
    for name, value in scope.get("headers", []):
        if name == b"authorization":
            return value.decode("latin-1")
    return None


async def app(scope, receive, send) -> None:
    """App ASGI do worker."""
    if scope["type"] != "http":  # pragma: no cover - só HTTP é servido
        return

    path = scope.get("path", "")

    if path == "/health/live":
        await _send_json(send, 200, {"status": "ok"})
        return

    if path == "/health/ready":
        from ..bootstrap import pipeline

        ready, details = await pipeline.readiness()
        await _send_json(
            send,
            200 if ready else 503,
            {"status": "ok" if ready else "unavailable", **details},
        )
        return

    if path in ("/metrics", "/metrics.json"):
        try:
            # Mesma regra de autorização da API do agente, e de propósito o mesmo
            # código: duas checagens equivalentes divergiriam na primeira mudança.
            require_metrics_token(_authorization(scope))
        except HTTPException as exc:
            await _send_json(send, exc.status_code, {"detail": exc.detail})
            return

        if path == "/metrics.json":
            await _send_json(send, 200, metrics.snapshot())
            return

        body, content_type = metrics.render()
        await _send_text(send, 200, body, content_type)
        return

    await _send_json(send, 404, {"detail": "not found"})


class WorkerObservabilityServer:
    """Ciclo de vida do servidor, acoplado ao do worker."""

    def __init__(self, port: int | None = None) -> None:
        self._port = port if port is not None else settings.worker_metrics_port
        self._server = None
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        import uvicorn

        config = uvicorn.Config(
            app,
            host="0.0.0.0",
            port=self._port,
            log_level="warning",
            access_log=False,
        )
        self._server = uvicorn.Server(config)
        # `serve()` roda em tarefa própria: o worker continua dono do loop.
        self._task = asyncio.create_task(self._server.serve())
        logger.info("Observabilidade do worker em http://0.0.0.0:%d/metrics", self._port)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            self._task = None
        self._server = None
