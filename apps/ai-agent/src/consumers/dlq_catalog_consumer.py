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

**Depois de catalogar, avisa o usuario.** Mensagem na DLQ e mensagem que nunca
teve resposta; antes o usuario ficava em silencio para sempre. O aviso e
best-effort — nunca impede o ack, porque a falha ja esta gravada — e limitado a
um por telefone a cada ``DLQ_USER_NOTICE_COOLDOWN_SECONDS``, para nao inundar
ninguem durante um incidente.
"""

from __future__ import annotations

import logging

from pydantic import ValidationError

from ..config import settings
from ..messaging.base import BrokerMessage, TransientError
from ..messaging.contracts import DlqEnvelopeV1
from ..observability.logging import log_context
from ..services.distributed_state import get_state_store
from ..services.failure_catalog import failure_catalog
from ..services.metrics import metrics
from ..services.outbound import outbound_dispatcher

logger = logging.getLogger(__name__)

#: ``sourceQueue`` -> ``source`` do catalogo. Fora deste mapa, derivamos do nome.
_SOURCE_POR_SUFIXO = {
    "inbound": "whatsapp_inbound",
    "processing": "whatsapp_processing",
    "outbound": "whatsapp_outbound",
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


#: Nao afirma que nada foi registrado: a falha pode ter vindo depois de o
#: lancamento ser criado (so a entrega da resposta falhou).
DLQ_USER_NOTICE = (
    "Tive um problema para processar sua última mensagem. "
    "Confira no app se o lançamento foi registrado antes de enviar de novo."
)


def notice_key(phone: str) -> str:
    return f"dlq:notified:{phone}"


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
                if not invalido:
                    await self._avisar_usuario(envelope)

    async def _avisar_usuario(self, envelope: DlqEnvelopeV1) -> None:
        """Avisa quem enviou a mensagem que falhou. **Nunca levanta.**

        A janela e marcada **antes** do envio: se o proprio WhatsApp e o que esta
        fora, cada falha da DLQ tentaria de novo e seguraria o consumer no timeout
        do envio. Assim e no maximo uma tentativa por telefone por janela.

        **Falha vinda da propria fila de saida nao gera aviso.** O aviso e uma
        mensagem de WhatsApp, entregue pela mesma fila que acabou de falhar: ele
        falharia igual, cairia na DLQ e geraria outro aviso. O cooldown
        atrasaria o ciclo, nao o impediria. Quem precisa saber que a entrega
        parou e o operador, pelo painel e pelo alerta de profundidade da DLQ —
        nao o usuario, por um canal que esta fora do ar.
        """
        cooldown = settings.dlq_user_notice_cooldown_seconds
        payload = envelope.payload if isinstance(envelope.payload, dict) else {}
        phone = payload.get("phone")
        if cooldown <= 0 or not isinstance(phone, str) or not phone:
            return
        if source_from_queue(envelope.source_queue) == "whatsapp_outbound":
            metrics.incr("dlq_user_notice_suppressed")
            logger.info("Falha da fila de saida: aviso suprimido para nao realimentar a DLQ")
            return

        try:
            store = get_state_store()
            chave = notice_key(phone)
            if await store.exists(chave):
                metrics.incr("dlq_user_notice_suppressed")
                return
            await store.mark(chave, cooldown)
            await outbound_dispatcher.send(phone, DLQ_USER_NOTICE, kind="notice")
            metrics.incr("dlq_user_notified")
        except Exception:  # noqa: BLE001 - a falha ja esta catalogada; o aviso e extra
            metrics.incr("dlq_user_notice_failed")
            logger.warning("Nao foi possivel avisar o usuario sobre a falha", exc_info=True)

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
