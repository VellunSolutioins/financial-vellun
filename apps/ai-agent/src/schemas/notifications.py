"""Contratos das notificações disparadas pela API principal."""

from pydantic import BaseModel, ConfigDict, Field


class WelcomeNotification(BaseModel):
    """Payload de ``POST /internal/notifications/welcome``.

    Aceita ``profileType`` (camelCase, como a API NestJS envia) e
    ``profile_type`` (snake_case) graças ao ``populate_by_name``.
    """

    model_config = ConfigDict(populate_by_name=True)

    phone: str
    name: str | None = None
    profile_type: str | None = Field(default=None, alias="profileType")
