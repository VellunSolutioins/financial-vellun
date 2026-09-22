"""Endpoints internos consumidos pela API principal (server-to-server).

Autenticados pela mesma ``INTERNAL_API_KEY`` compartilhada entre API e agente
(header ``x-internal-api-key``). Não expostos ao WhatsApp/Internet pública.
"""

import hmac
import logging

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ValidationError

from ..bootstrap import pipeline
from ..config import settings
from ..messaging.base import ROUTE_INBOUND, ROUTE_PROCESSING, PublishError
from ..messaging.contracts import InboundMessageV1, ProcessingJobV1
from ..schemas.ops import ReprocessRequest
from ..services.metrics import metrics

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal", tags=["internal"])

#: Allowlist de destinos do reprocessamento: rota lógica -> contrato publicado.
#:
#: Só existem duas, e a única forma de acrescentar uma terceira é editando este
#: mapa. Exchange e nome físico de fila continuam saindo da configuração, nunca
#: do pedido — quem chama escolhe entre duas rotas conhecidas, não um destino.
_DESTINOS: dict[str, type[BaseModel]] = {
    ROUTE_INBOUND: InboundMessageV1,
    ROUTE_PROCESSING: ProcessingJobV1,
}


def _require_internal_key(x_internal_api_key: str | None = Header(default=None)) -> None:
    """Valida a chave interna em tempo constante (evita timing attacks)."""
    expected = settings.internal_api_key
    if not x_internal_api_key or not hmac.compare_digest(x_internal_api_key, expected):
        raise HTTPException(status_code=401, detail="Chave de API interna inválida")


@router.post("/ops/reprocess")
async def reprocess(
    payload: ReprocessRequest, x_internal_api_key: str | None = Header(default=None)
) -> dict:
    """Republica uma mensagem do catálogo de falhas na fila de origem.

    **O código de status é o contrato**, e a API principal decide o destino da
    linha do catálogo a partir dele:

    - ``422`` — o payload não valida contra o contrato. Nada foi publicado, e
      isso é **certo**: a mensagem nem chegou ao broker.
    - ``503`` — não há publisher, ou o broker não confirmou. Aqui **não** se sabe
      se a mensagem entrou: um confirm que não chega não prova que a publicação
      não aconteceu. A API deixa a linha em ``reprocessing`` para o cron
      reconciliar, em vez de fingir certeza.
    - ``200`` — publicado **com confirm do broker**.
    """
    _require_internal_key(x_internal_api_key)

    contrato = _DESTINOS.get(payload.route)
    if contrato is None:
        # Inalcançável pelo Literal do schema; existe para que acrescentar uma
        # rota ao contrato sem acrescentar ao mapa falhe alto, não em silêncio.
        raise HTTPException(status_code=422, detail=f"rota não permitida: {payload.route}")

    try:
        mensagem = contrato.model_validate(payload.message)
    except ValidationError as exc:
        # Revalidar aqui não é redundância: o payload foi gravado no catálogo
        # quando a mensagem já havia falhado, e uma mensagem malformada é
        # exatamente um dos motivos de ela ter ido parar na DLQ. Republicar sem
        # validar a devolveria para a mesma DLQ, com uma tentativa a mais.
        logger.warning("Reprocessamento recusado: payload inválido para %s", payload.route)
        raise HTTPException(
            status_code=422, detail=f"payload inválido para {payload.route}: {exc.errors()[:3]}"
        ) from exc

    try:
        publisher = pipeline.require_publisher()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="publisher de mensageria indisponível") from exc

    try:
        await publisher.publish(
            payload.route, mensagem, correlation_id=payload.correlation_id
        )
    except PublishError as exc:
        metrics.incr("ops_reprocess_publish_failed")
        logger.error("Reprocessamento sem confirm do broker em %s", payload.route, exc_info=exc)
        raise HTTPException(status_code=503, detail="broker não confirmou a publicação") from exc

    metrics.incr("ops_reprocess_published")
    logger.info(
        "Mensagem reprocessada publicada em %s (correlação %s)",
        payload.route,
        payload.correlation_id or "-",
    )
    return {"status": "published", "route": payload.route}
