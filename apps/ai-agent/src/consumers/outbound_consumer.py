"""Consumer de ``whatsapp.outbound.v1``: entrega a resposta ao usuário.

É a única coisa que faz. **Não decide identidade** (contrato C5): o telefone já
veio resolvido por quem publicou, e reconsultá-lo aqui abriria a porta para
entregar a um dono diferente do que o fluxo enxergou.

A classificação de falha vem pronta do ``WhatsappCloudApiMessenger`` e a
política de ack do broker faz o resto:

- rede, ``429`` e ``5xx`` → :class:`TransientError` → retry com backoff, até
  ``MESSAGE_MAX_RETRIES``; esgotadas, DLQ;
- demais ``4xx`` (token inválido, número fora da janela de 24 h, payload
  recusado) → :class:`PermanentError` → DLQ direto, porque repetir não muda a
  resposta da Meta.

**Deduplicação por ``jobId``.** Uma reentrega do broker (ack perdido, shutdown
no meio) não pode virar uma segunda mensagem no celular de alguém. O marcador
`job:sent:{jobId}` é gravado depois do envio e conferido antes: cobre tanto a
reentrega quanto uma republicação em duplicidade pelo consumer de processamento.
Resta a janela entre "a Meta aceitou" e "o marcador foi gravado" — nela, um
crash ainda pode duplicar. Não existe entrega exatamente-uma-vez contra uma API
externa; o que existe é estreitar a janela e não fingir o contrário.
"""

from __future__ import annotations

import logging
import time

from pydantic import ValidationError

from ..config import settings
from ..messaging.base import BrokerMessage, PermanentError
from ..messaging.contracts import OutboundMessageV1
from ..observability.logging import log_context
from ..services.distributed_state import StateStore, get_state_store
from ..services.message_processor import message_processor
from ..services.metrics import metrics

logger = logging.getLogger(__name__)


def sent_key(job_id: str) -> str:
    return f"job:sent:{job_id}"


class OutboundMessageConsumer:
    def __init__(self, store: StateStore | None = None) -> None:
        self._store = store

    @property
    def store(self) -> StateStore:
        if self._store is None:
            self._store = get_state_store()
        return self._store

    async def handle(self, broker_message: BrokerMessage) -> None:
        try:
            message = OutboundMessageV1.model_validate_json(broker_message.body)
        except ValidationError as exc:
            raise PermanentError(
                f"contrato outbound inválido: {exc.error_count()} erro(s)"
            ) from exc

        with log_context(
            correlation_id=message.correlation_id,
            job_id=message.job_id,
            phone=message.phone,
        ):
            chave = sent_key(message.job_id) if message.job_id else None
            if chave is not None and await self.store.exists(chave):
                metrics.incr("outbound_duplicated")
                logger.info("Resposta deste job já foi entregue; ignorando reentrega")
                return

            started = time.monotonic()
            await message_processor.deliver(message.phone, message.text)
            metrics.observe_ms("outbound_send_ms", (time.monotonic() - started) * 1000)
            metrics.incr("outbound_sent")

            if chave is not None:
                # Depois do envio, nunca antes: marcar primeiro e falhar o envio
                # deixaria o usuário sem resposta e sem retry.
                await self.store.mark(chave, settings.job_dedupe_ttl_seconds)
