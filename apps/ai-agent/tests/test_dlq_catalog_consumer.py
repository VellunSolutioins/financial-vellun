"""Consumer que drena as DLQs para o catalogo de falhas.

A garantia central da Entrega 5: **grava antes de ackar**. Se a API estiver fora,
a mensagem volta para a DLQ e nada se perde — o catalogo fica atrasado, nunca
incompleto em silencio.
"""

from __future__ import annotations

import json

import pytest

from src.consumers import DlqCatalogMessageConsumer, source_from_queue
from src.consumers.dlq_catalog_consumer import DLQ_USER_NOTICE
from src.messaging.base import BrokerMessage, PermanentError, TransientError
from src.messaging.contracts import DlqEnvelopeV1

FILA = "whatsapp.processing.dlq"
ROUTING_KEY = "processing.dlq"


class FakeCatalogo:
    """Dublê da API. `disponivel=False` simula a API fora."""

    def __init__(self, disponivel: bool = True) -> None:
        self.disponivel = disponivel
        self.chamadas: list[dict] = []
        self.vistos: set[str] = set()

    async def capture(self, **kwargs):
        self.chamadas.append(kwargs)
        if not self.disponivel:
            return None

        chave = f"{kwargs['source_queue']}|{kwargs['failed_at']}|{kwargs['correlation_id']}"
        if chave in self.vistos:
            return {"id": "ja-existia", "duplicate": True}
        self.vistos.add(chave)
        return {"id": f"falha-{len(self.vistos)}", "duplicate": False}


class FakeEntrega:
    """Dublê do despachante de saída. `erro` simula o WhatsApp recusando.

    Desde o P3 o aviso não é entregue aqui: ele é publicado na fila de saída e
    entregue pelo consumer de outbound. O que o teste continua verificando é o
    mesmo — que o aviso sai, uma vez por telefone por janela, e que falhar nele
    não impede o ack.
    """

    def __init__(self) -> None:
        self.enviadas: list[tuple[str, str]] = []
        self.erro: BaseException | None = None

    async def send(self, phone, text, **kwargs):
        if self.erro is not None:
            raise self.erro
        self.enviadas.append((phone, text))
        return text


@pytest.fixture
def entrega(monkeypatch):
    fake = FakeEntrega()
    import src.consumers.dlq_catalog_consumer as module

    monkeypatch.setattr(module, "outbound_dispatcher", fake)
    return fake


@pytest.fixture
def catalogo(monkeypatch, entrega):
    fake = FakeCatalogo()
    import src.consumers.dlq_catalog_consumer as module

    monkeypatch.setattr(module, "failure_catalog", fake)
    return fake


def envelope(**overrides) -> DlqEnvelopeV1:
    base = dict(
        payload={"phone": "+5541999999999", "text": "gastei 50", "providerMessageId": "wamid.1"},
        source_queue="whatsapp.processing.v1",
        routing_key="processing",
        attempts=5,
        error_type="ConnectionError",
        error_message="API fora",
        permanent=False,
        correlation_id="corr-1",
    )
    base.update(overrides)
    return DlqEnvelopeV1(**base)


def mensagem(env: DlqEnvelopeV1) -> BrokerMessage:
    return BrokerMessage(
        body=env.model_dump_json(by_alias=True).encode(),
        routing_key=ROUTING_KEY,
        correlation_id=env.correlation_id,
    )


def consumer() -> DlqCatalogMessageConsumer:
    return DlqCatalogMessageConsumer(FILA, ROUTING_KEY)


# ── Mapeamento de origem ─────────────────────────────────────────────────────
def test_origem_derivada_do_nome_da_fila():
    assert source_from_queue("whatsapp.inbound.v1") == "whatsapp_inbound"
    assert source_from_queue("whatsapp.processing.v1") == "whatsapp_processing"


def test_fila_desconhecida_ainda_e_catalogada():
    # Perder a falha por causa de um nome novo seria pior que classificar de
    # forma imprecisa.
    assert source_from_queue("fila.nova.v1") == "whatsapp_inbound"


# ── Caminho feliz ────────────────────────────────────────────────────────────
async def test_falha_e_enviada_ao_catalogo_com_o_envelope_inteiro(catalogo):
    await consumer().handle(mensagem(envelope()))

    assert len(catalogo.chamadas) == 1
    enviado = catalogo.chamadas[0]
    assert enviado["source"] == "whatsapp_processing"
    assert enviado["source_queue"] == "whatsapp.processing.v1"
    assert enviado["error_type"] == "ConnectionError"
    assert enviado["attempts"] == 5
    assert enviado["correlation_id"] == "corr-1"
    # O payload vai integro: e o que sera republicado.
    assert enviado["payload"]["text"] == "gastei 50"
    assert enviado["payload"]["phone"] == "+5541999999999"


async def test_primeira_falha_e_preservada_quando_existe(catalogo):
    from datetime import datetime, timezone

    primeiro = datetime(2026, 9, 5, 17, 59, 12, tzinfo=timezone.utc)
    await consumer().handle(mensagem(envelope(first_failed_at=primeiro)))

    assert catalogo.chamadas[0]["first_failed_at"] == primeiro.isoformat()


async def test_sem_primeira_falha_envia_nulo(catalogo):
    await consumer().handle(mensagem(envelope()))

    assert catalogo.chamadas[0]["first_failed_at"] is None


# ── A garantia central ───────────────────────────────────────────────────────
async def test_api_fora_levanta_para_a_mensagem_voltar_a_dlq(catalogo):
    """Nao ackar e o que impede a falha de sumir em silencio."""
    catalogo.disponivel = False

    with pytest.raises(TransientError):
        await consumer().handle(mensagem(envelope()))


async def test_duplicata_nao_levanta_e_e_ackada(catalogo):
    """Reentrega da mesma mensagem nao pode travar a fila."""
    msg = mensagem(envelope())

    await consumer().handle(msg)
    await consumer().handle(msg)  # nao levanta

    assert len(catalogo.chamadas) == 2
    assert len(catalogo.vistos) == 1


# ── Envelope invalido ────────────────────────────────────────────────────────
async def test_envelope_invalido_e_catalogado_em_vez_de_voltar_a_fila(catalogo):
    """Uma mensagem que nunca vai validar ficaria em loop eterno.

    Catalogada, ela aparece no painel com um `errorType` que diz o que houve, e o
    payload cru vai junto para o operador decidir.
    """
    msg = BrokerMessage(body=b'{"isso": "nao e um envelope"}', routing_key=ROUTING_KEY)

    await consumer().handle(msg)  # nao levanta

    enviado = catalogo.chamadas[0]
    assert enviado["error_type"] == "InvalidDlqEnvelope"
    assert enviado["permanent"] is True
    assert enviado["source_queue"] == FILA
    assert "nao e um envelope" in json.dumps(enviado["payload"])


async def test_corpo_nao_json_tambem_e_catalogado(catalogo):
    msg = BrokerMessage(body=b"\xff\xfe nao json", routing_key=ROUTING_KEY)

    await consumer().handle(msg)

    assert catalogo.chamadas[0]["error_type"] == "InvalidDlqEnvelope"
    assert "raw" in catalogo.chamadas[0]["payload"]


# ── Aviso ao usuario ─────────────────────────────────────────────────────────
async def test_usuario_e_avisado_depois_de_catalogar(catalogo, entrega):
    """Mensagem na DLQ e mensagem sem resposta: o usuario nao pode ficar no silencio."""
    await consumer().handle(mensagem(envelope()))

    assert entrega.enviadas == [("+5541999999999", DLQ_USER_NOTICE)]


async def test_aviso_limitado_a_um_por_telefone_na_janela(catalogo, entrega):
    # Duas falhas distintas do mesmo telefone num incidente: um aviso so.
    await consumer().handle(mensagem(envelope(correlation_id="corr-1")))
    await consumer().handle(mensagem(envelope(correlation_id="corr-2")))

    assert len(catalogo.vistos) == 2
    assert len(entrega.enviadas) == 1


async def test_duplicata_nao_avisa_de_novo(catalogo, entrega):
    from src.consumers.dlq_catalog_consumer import notice_key
    from src.services.distributed_state import get_state_store

    msg = mensagem(envelope())
    await consumer().handle(msg)
    # Janela ja vencida na reentrega: so a deduplicacao do catalogo impede o
    # segundo aviso.
    await get_state_store().forget(notice_key("+5541999999999"))
    await consumer().handle(msg)

    assert len(entrega.enviadas) == 1


async def test_falha_ao_avisar_nao_impede_o_ack(catalogo, entrega):
    """A falha ja esta gravada; o aviso e extra e nunca devolve a mensagem a fila."""
    entrega.erro = PermanentError("WhatsApp Cloud API recusou envio: HTTP 401")

    await consumer().handle(mensagem(envelope()))  # nao levanta

    assert len(catalogo.vistos) == 1


async def test_api_fora_nao_avisa(catalogo, entrega):
    # Sem catalogar, a mensagem volta a DLQ e sera entregue de novo: avisar agora
    # repetiria o aviso a cada volta.
    catalogo.disponivel = False

    with pytest.raises(TransientError):
        await consumer().handle(mensagem(envelope()))

    assert entrega.enviadas == []


async def test_envelope_sem_telefone_nao_avisa(catalogo, entrega):
    await consumer().handle(mensagem(envelope(payload={"raw": "corpo ilegivel"})))
    await consumer().handle(BrokerMessage(body=b"nao json", routing_key=ROUTING_KEY))

    assert entrega.enviadas == []


async def test_aviso_desligado_com_janela_zero(catalogo, entrega, monkeypatch):
    from src.config import settings

    monkeypatch.setattr(settings, "dlq_user_notice_cooldown_seconds", 0)

    await consumer().handle(mensagem(envelope()))

    assert entrega.enviadas == []
