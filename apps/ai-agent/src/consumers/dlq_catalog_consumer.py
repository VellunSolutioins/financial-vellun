"""Consumer que drena as DLQs para o catalogo de falhas no Postgres.

**A DLQ e transporte; o Postgres e a fonte de verdade do que falhou.**

O RabbitMQ nao oferece navegacao arbitraria, paginacao nem filtro. Montar a tela
de operacoes lendo a DLQ transformaria cada abertura de pagina em consumo e
republicacao da fila — exatamente o que nao pode acontecer. Entao este consumer
le a DLQ uma vez, grava em ``ops_failed_messages`` e so entao acka.

A garantia que sustenta o desenho: **grava antes de ackar**. Se a API estiver
fora, o handler levanta, a mensagem volta para a DLQ e nada se perde — o catalogo
fica atrasado, e a profundidade da fila dispara o alerta. O contrario (ackar e
depois gravar) perderia a falha em silencio, que e o pior desfecho possivel para
uma tabela cujo proposito e justamente nao perder falha.

Mensagem que nao valida como ``DlqEnvelopeV1`` **nao** volta para a fila: seria um
loop infinito, porque nenhuma tentativa futura a fara validar. Ela e catalogada
como esta, com ``errorType`` proprio, e o payload cru vai junto para o operador
decidir.
"""

from __future__ import annotations

import logging

from pydantic import ValidationError

from ..messaging.base import BrokerMessage, TransientError
from ..messaging.contracts import DlqEnvelopeV1
from ..observability.logging import log_context
from ..services.failure_catalog import failure_catalog
from ..services.metrics import metrics

logger = logging.getLogger(__name__)

#: ``sourceQueue`` -> ``source`` do catalogo. Fora deste mapa, derivamos do nome.
_SOURCE_POR_SUFIXO = {
    "inbound": "whatsapp_inbound",
    "processing": "whatsapp_processing",
}


def source_from_queue(source_queue: str) -> str:
    """``whatsapp.processing.v1`` -> ``whatsapp_processing``."""
    for sufixo, source in _SOURCE_POR_SUFIXO.items():
        if sufixo in source_queue:
            return source
    # Fila desconhecida ainda deve ser catalogada: perder a falha por causa de um
    # nome novo seria pior que classifica-la de forma imprecisa.
    logger.warning("Fila de origem nao reconhecida: %s", source_queue)
    return "whatsapp_inbound"


class DlqCatalogMessageConsumer:
    """Handler de uma mensagem de DLQ."""

    def __init__(self, source_queue: str, routing_key: str) -> None:
        self._source_queue = source_queue
        self._routing_key = routing_key

    async def handle(self, broker_message: BrokerMessage) -> None:
        envelope, invalido = self._parse(broker_message)

        with log_context(correlation_id=envelope.correlation_id):
            registrado = await failure_catalog.capture(
                source=source_from_queue(envelope.source_queue),
                source_queue=envelope.source_queue,
                routing_key=envelope.routing_key,
                correlation_id=envelope.correlation_id,
                attempts=envelope.attempts,
                error_type=envelope.error_type,
                error_message=envelope.error_message,
                permanent=envelope.permanent,
                payload=envelope.payload,
                first_failed_at=(
                    envelope.first_failed_at.isoformat() if envelope.first_failed_at else None
                ),
                failed_at=envelope.failed_at.isoformat(),
            )

            if registrado is None:
                # A API nao confirmou. Levantar devolve a mensagem a DLQ.
                metrics.incr("dlq_catalog_failed")
                raise TransientError("API principal indisponivel ao catalogar a falha")

            if registrado.get("duplicate"):
                metrics.incr("dlq_catalog_duplicated")
                logger.info("Falha ja estava no catalogo; ackando sem duplicar")
            else:
                metrics.incr("dlq_catalog_captured")
                if invalido:
                    metrics.incr("dlq_catalog_invalid_envelope")
                logger.info(
                    "Falha catalogada (%s, %s)", envelope.source_queue, envelope.error_type
                )

    def _parse(self, broker_message: BrokerMessage) -> tuple[DlqEnvelopeV1, bool]:
        """Envelope validado, ou um envelope sintetico para o payload cru.

        Devolver e catalogar o invalido — em vez de recusar — e deliberado: uma
        mensagem que nunca vai validar ficaria em loop eterno entre a fila e o
        consumer, e o operador nunca a veria. Catalogada, ela aparece no painel
        com um ``errorType`` que diz exatamente o que houve.
        """
        try:
            return DlqEnvelopeV1.model_validate_json(broker_message.body), False
        except ValidationError as exc:
            logger.error(
                "Envelope de DLQ invalido em %s (%d erro(s)); catalogando como cru",
                self._source_queue,
                exc.error_count(),
            )
            bruto = broker_message.body.decode("utf-8", errors="replace")[:4000]
            return (
                DlqEnvelopeV1(
                    payload={"raw": bruto},
                    source_queue=self._source_queue,
                    routing_key=self._routing_key,
                    attempts=0,
                    error_type="InvalidDlqEnvelope",
                    error_message=f"envelope nao valida: {exc.error_count()} erro(s)",
                    permanent=True,
                    correlation_id=broker_message.correlation_id,
                ),
                True,
            )
