from contextlib import asynccontextmanager

from fastapi import FastAPI

from .routers import health, metrics, webhook
from .services.message_buffer import message_buffer


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
