"""Ponto único de saída de mensagem para o usuário.

Todo texto que o agente responde passa por aqui — resposta de job, aviso de
número não vinculado, bloqueio de assinatura, aviso de falha da DLQ. Com
``OUTBOUND_DELIVERY=queue`` (padrão) a mensagem é **publicada** em
``whatsapp.outbound.v1`` e entregue por um consumer próprio; com ``direct``, ou
no pipeline legado, é entregue na hora, como antes.

Por que a fila: enquanto o envio acontecia dentro do consumer de processamento,
uma indisponibilidade do WhatsApp segurava o job inteiro no timeout da Graph
API. O job não podia ser ackado (a resposta não saiu) e o retry refazia um
trabalho cujos efeitos não se repetem com segurança. Separando, o processamento
acka assim que o estado está persistido e a indisponibilidade vira backlog numa
fila só — que é observável, drenável e que não impede lançamento nenhum de ser
registrado.

O despachante é um singleton com o publisher **injetado** pelo ``bootstrap``:
quem chama não precisa carregar o publisher até aqui, e sem pipeline no ar o
comportamento degrada para a entrega direta em vez de falhar.
"""

from __future__ import annotations

import logging
from typing import Literal

from ..config import settings
from ..messaging.base import ROUTE_OUTBOUND, MessagePublisher
from ..messaging.contracts import OutboundMessageV1
from ..observability.logging import current_context
from .metrics import metrics

logger = logging.getLogger(__name__)


class OutboundDispatcher:
    def __init__(self) -> None:
        self._publisher: MessagePublisher | None = None

    def bind(self, publisher: MessagePublisher | None) -> None:
        """Liga (ou desliga, com ``None``) o publisher usado para enfileirar."""
        self._publisher = publisher

    def uses_queue(self) -> bool:
        return settings.is_queued_outbound and self._publisher is not None

    async def send(
        self,
        phone: str,
        text: str,
        *,
        kind: Literal["reply", "notice"] = "reply",
        job_id: str | None = None,
        user_id: str | None = None,
        contact_id: str | None = None,
    ) -> None:
        """Entrega ``text`` a ``phone`` — enfileirando ou na hora.

        Levanta como o envio direto levantaria: quem chama decide se a falha é
        fatal. Com fila, o que pode falhar aqui é a **publicação**, e falhar é o
        certo — perder a publicação em silêncio seria o usuário sem resposta.
        """
        if not text:
            return

        if not self.uses_queue():
            from .message_processor import message_processor

            await message_processor.deliver(phone, text)
            return

        assert self._publisher is not None
        # A correlação do contexto segue com a mensagem: sem isso, o log da
        # entrega ficaria órfão do fluxo que a originou — e é justamente na
        # entrega que se pergunta "por que este usuário não recebeu resposta?".
        correlacao = current_context().correlation_id
        campos = dict(
            phone=phone,
            text=text,
            kind=kind,
            job_id=job_id,
            user_id=user_id,
            contact_id=contact_id,
        )
        message = (
            OutboundMessageV1(**campos, correlation_id=correlacao)
            if correlacao
            else OutboundMessageV1(**campos)
        )
        await self._publisher.publish(
            ROUTE_OUTBOUND, message, correlation_id=message.correlation_id
        )
        metrics.incr("outbound_published")
        logger.debug("Resposta enfileirada para entrega (kind=%s)", kind)


outbound_dispatcher = OutboundDispatcher()
