"""Entrypoint do worker: consome as filas sem servir HTTP.

Use quando ``RUN_CONSUMERS_IN_API=false`` para escalar o processamento
independentemente da camada que recebe os webhooks:

    python -m src.worker

Encerra de forma graciosa em SIGINT/SIGTERM, devolvendo a fila o que nao
terminou.
"""

from __future__ import annotations

import asyncio
import logging
import signal

from .bootstrap import pipeline
from .observability.logging import configure_logging

logger = logging.getLogger(__name__)


async def run() -> None:
    configure_logging()
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

    await pipeline.start_consumers()
    logger.info("Worker pronto; aguardando mensagens")
    try:
        await stop_event.wait()
    finally:
        logger.info("Encerrando worker...")
        await pipeline.stop()


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
