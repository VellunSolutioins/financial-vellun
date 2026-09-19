"""Entrypoint do worker: consome as filas.

Use quando ``RUN_CONSUMERS_IN_API=false`` para escalar o processamento
independentemente da camada que recebe os webhooks:

    python -m src.worker

Serve um HTTP **mínimo** (``/metrics`` e ``/health/*``, porta
``WORKER_METRICS_PORT``) e nada mais. Sem ele as réplicas de consumo ficariam
invisíveis para o scrape e para o orquestrador — e é aqui que o trabalho
acontece. Ver ``observability/worker_server.py``.

Encerra de forma graciosa em SIGINT/SIGTERM, devolvendo a fila o que nao
terminou.
"""

from __future__ import annotations

import asyncio
import logging
import signal

from .bootstrap import log_runtime_config, pipeline
from .observability.logging import configure_logging
from .observability.worker_server import WorkerObservabilityServer

logger = logging.getLogger(__name__)


async def run() -> None:
    # `ai-agent-worker` como serviço: no Loki, separar o consumo da camada HTTP é
    # o que permite perguntar "o consumo está com problema?" sem que as duas
    # metades se misturem numa consulta só.
    configure_logging(service="ai-agent-worker")
    log_runtime_config()
    stop_event = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (getattr(signal, "SIGINT", None), getattr(signal, "SIGTERM", None)):
        if sig is None:
            continue
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            # Windows nao suporta add_signal_handler; o KeyboardInterrupt cobre.
            signal.signal(sig, lambda *_: stop_event.set())

    # A observabilidade sobe **antes** dos consumers: se a conexão com o broker
    # falhar, o readiness precisa estar respondendo 503 para dizer isso, em vez
    # de o processo simplesmente não abrir porta nenhuma.
    observability = WorkerObservabilityServer()
    await observability.start()

    try:
        await pipeline.start_consumers()
        logger.info("Worker pronto; aguardando mensagens")
        await stop_event.wait()
    finally:
        logger.info("Encerrando worker...")
        await pipeline.stop()
        await observability.stop()


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
