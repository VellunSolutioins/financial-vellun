import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import settings
from .routers import health, internal, metrics, webhook
from .services.message_buffer import message_buffer

# Uvicorn só configura seus próprios loggers (uvicorn*), deixando o logger raiz
# sem handler — o que faz o Python descartar todo log de nível INFO da aplicação
# (ex.: o envio do LogMessenger). Configuramos o raiz aqui para tornar esses
# logs visíveis no console em desenvolvimento.
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Inicia o worker do buffer (no-op no backend em memória).
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

app.include_router(health.router)
app.include_router(metrics.router)
app.include_router(webhook.router)
app.include_router(internal.router)
