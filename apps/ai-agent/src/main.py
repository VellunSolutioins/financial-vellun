import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .bootstrap import log_runtime_config, pipeline
from .config import settings
from .observability.logging import configure_logging
from .observability.middleware import CorrelationIdMiddleware
from .routers import health, internal, metrics, webhook

configure_logging()

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log_runtime_config()
    if settings.is_broker_pipeline:
        # O publisher e obrigatorio: sem ele o webhook nao consegue responder 202.
        await pipeline.start_publisher()
        if settings.run_consumers_in_api:
            await pipeline.start_consumers()
        else:
            logger.info(
                "Consumers desabilitados nesta instancia (RUN_CONSUMERS_IN_API=false)"
            )
        try:
            yield
        finally:
            await pipeline.stop()
        return

    # Modo legado: buffer em processo, sem broker.
    logger.warning("MESSAGE_PIPELINE=legacy: usando o buffer em processo")
    from .services.message_buffer import message_buffer

    await message_buffer.start()
    try:
        yield
    finally:
        await message_buffer.stop()


app = FastAPI(
    title="Financial Vellun AI Agent",
    description="Agente de IA para processamento de mensagens WhatsApp",
    version="0.0.1",
    lifespan=lifespan,
)

# Primeiro middleware da cadeia: nenhum log de requisicao deve sair sem
# `correlationId`, inclusive o de um erro em outro middleware.
app.add_middleware(CorrelationIdMiddleware)

app.include_router(health.router)
app.include_router(metrics.router)
app.include_router(webhook.router)
app.include_router(internal.router)
