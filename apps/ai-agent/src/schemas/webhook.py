from pydantic import BaseModel, Field


class WhatsappWebhookPayload(BaseModel):
    """Payload de mensagem recebida do provedor de WhatsApp (simulado no MVP)."""

    phone: str = Field(..., description="Número de telefone do remetente, ex.: +5511999999999")
    message: str = Field(..., description="Texto da mensagem enviada pelo usuário")
    timestamp: int | None = Field(default=None, description="Epoch em segundos")
    message_id: str | None = Field(default=None, description="ID único da mensagem no provedor")
