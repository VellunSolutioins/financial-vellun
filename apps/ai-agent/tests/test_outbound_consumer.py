"""Entrega assíncrona: fila de saída, deduplicação e isolamento da falha.

O critério de aceite do P3 é o segundo teste daqui: *com o WhatsApp
indisponível, o processing continua e o backlog cresce só em
``whatsapp.outbound.v1``*. Era exatamente o que não acontecia antes — a recusa
da Meta segurava o job de processamento, que não podia ser ackado, e o retry
refazia um trabalho cujos efeitos não se repetem com segurança.
"""

from __future__ import annotations

import pytest

from src.consumers.outbound_consumer import OutboundMessageConsumer, sent_key
from src.messaging.base import (
    ROUTE_OUTBOUND,
    ROUTE_PROCESSING,
    BrokerMessage,
    PermanentError,
    TransientError,
)
from src.messaging.contracts import OutboundMessageV1
from src.messaging.factory import inmemory_broker
from src.messaging.inmemory import InMemoryPublisher
from src.services.distributed_state import get_state_store
from src.services.outbound import outbound_dispatcher

PHONE = "+5541999999999"


class FakeMessenger:
    """Dublê do WhatsApp. `erro` simula recusa ou indisponibilidade."""

    def __init__(self) -> None:
        self.enviadas: list[tuple[str, str]] = []
        self.erro: BaseException | None = None

    async def send(self, phone: str, text: str) -> None:
        if self.erro is not None:
            raise self.erro
        self.enviadas.append((phone, text))


@pytest.fixture
def whatsapp(monkeypatch):
    fake = FakeMessenger()
    import src.services.message_processor as mp

    monkeypatch.setattr(mp, "messenger", fake)

    class SemAuditoria:
        async def log_message(self, *args, **kwargs):
            return None

    monkeypatch.setattr(mp, "audit_service", SemAuditoria())
    return fake


def mensagem(text: str = "Lançamento criado!", job_id: str | None = "job-1") -> BrokerMessage:
    payload = OutboundMessageV1(phone=PHONE, text=text, job_id=job_id)
    return BrokerMessage(
        body=payload.model_dump_json(by_alias=True).encode(), routing_key=ROUTE_OUTBOUND
    )


async def test_entrega_a_mensagem_e_marca_o_job_como_entregue(whatsapp):
    await OutboundMessageConsumer().handle(mensagem())

    assert whatsapp.enviadas == [(PHONE, "Lançamento criado!")]
    assert await get_state_store().exists(sent_key("job-1")) is True


async def test_reentrega_do_broker_nao_manda_a_mensagem_duas_vezes(whatsapp):
    consumer = OutboundMessageConsumer()
    await consumer.handle(mensagem())
    # Mesma mensagem de novo: ack perdido, shutdown no meio, republicação em
    # duplicidade — para o usuário, todos são "recebi duas vezes".
    await consumer.handle(mensagem())

    assert len(whatsapp.enviadas) == 1


async def test_sem_job_id_nao_deduplica(whatsapp):
    """Aviso solto (número não vinculado) não tem chave de deduplicação.

    Repeti-lo é bem menos grave que suprimir um aviso legítimo por colisão de
    chave inventada.
    """
    consumer = OutboundMessageConsumer()
    await consumer.handle(mensagem("Seu número não está vinculado.", job_id=None))
    await consumer.handle(mensagem("Seu número não está vinculado.", job_id=None))

    assert len(whatsapp.enviadas) == 2


async def test_contrato_invalido_vai_direto_para_a_dlq():
    with pytest.raises(PermanentError):
        await OutboundMessageConsumer().handle(
            BrokerMessage(body=b'{"phone": ""}', routing_key=ROUTE_OUTBOUND)
        )


async def test_indisponibilidade_do_whatsapp_propaga_para_o_retry(whatsapp):
    """5xx e 429 levantam `TransientError`: o broker reagenda com backoff."""
    whatsapp.erro = TransientError("WhatsApp Cloud API indisponível: HTTP 503")

    with pytest.raises(TransientError):
        await OutboundMessageConsumer().handle(mensagem())

    # Nada marcado: a próxima tentativa precisa enviar de verdade.
    assert await get_state_store().exists(sent_key("job-1")) is False


async def test_backlog_cresce_so_na_fila_de_saida(whatsapp):
    """Critério de aceite do P3.

    Com o WhatsApp fora, o consumer de processamento termina e acka; o que se
    acumula é a fila de saída. O lançamento do usuário já está registrado — a
    única coisa pendente é o aviso de que ele foi.
    """
    broker = inmemory_broker()
    outbound_dispatcher.bind(InMemoryPublisher(broker))
    await outbound_dispatcher.send(PHONE, "Lançamento criado!", job_id="job-1")

    assert len(broker.published[ROUTE_OUTBOUND]) == 1
    assert broker.published[ROUTE_PROCESSING] == []

    whatsapp.erro = TransientError("WhatsApp Cloud API indisponível: HTTP 503")
    broker.register(ROUTE_OUTBOUND, OutboundMessageConsumer().handle)
    await broker.drain()

    # Esgotadas as tentativas, a mensagem vai para a DLQ — da fila de saída, e
    # de nenhuma outra.
    assert [e.source_queue for e in broker.dlq] == [ROUTE_OUTBOUND]
    assert whatsapp.enviadas == []


async def test_rollback_por_configuracao_entrega_na_hora(whatsapp, monkeypatch):
    """`OUTBOUND_DELIVERY=direct` volta ao comportamento anterior sem deploy."""
    from src.config import settings

    broker = inmemory_broker()
    outbound_dispatcher.bind(InMemoryPublisher(broker))
    monkeypatch.setattr(settings, "outbound_delivery", "direct")

    await outbound_dispatcher.send(PHONE, "Lançamento criado!", job_id="job-1")

    assert whatsapp.enviadas == [(PHONE, "Lançamento criado!")]
    assert broker.published[ROUTE_OUTBOUND] == []
