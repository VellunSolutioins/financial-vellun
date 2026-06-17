from fastapi import FastAPI

from .config import settings
from .routers import health, webhook

app = FastAPI(
    title="Financial Vellun AI Agent",
    description="Agente de IA para processamento de mensagens WhatsApp",
    version="0.0.1",
)

app.include_router(health.router)
app.include_router(webhook.router)
