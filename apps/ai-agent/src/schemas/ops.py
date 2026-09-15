"""Contratos dos endpoints internos da area de operacoes."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ReprocessRequest(BaseModel):
    """Payload de ``POST /internal/ops/reprocess``.

    ``route`` e uma **routing key logica** (``inbound`` / ``processing``), nao o
    nome fisico de uma fila nem uma exchange. O `Literal` e a segunda barreira:
    a API principal ja deriva o destino de uma allowlist propria, e nada disso
    vem do navegador em momento algum.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    route: Literal["inbound", "processing"]
    #: O payload original da falha, como foi capturado da DLQ.
    message: dict[str, Any]
    correlation_id: str | None = Field(default=None, alias="correlationId")
