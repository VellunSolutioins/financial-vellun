"""Ponta a ponta: webhook → inbound → agrupamento → processing → resposta.

Os outros testes cobrem cada camada com dublês nas fronteiras — e foi numa
fronteira que o incidente morou: o webhook devolvia ``202`` e nada mais
acontecia, sem que nenhum teste percorresse o caminho inteiro. Aqui sobem os
consumers **reais** e o flusher **real** (``pipeline.start_consumers()``), com o
broker e o agrupamento em memória. Só o que sai do processo é dublê: API
principal, LLM e WhatsApp.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from src.bootstrap import pipeline
from src.config import settings
from src.consumers import DlqCatalogMessageConsumer
from src.main import app
from src.messaging.base import BrokerMessage, PermanentError
from src.schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum
from src.services.distributed_state import get_state_store

PHONE = "+5541999999999"

WEBHOOK = {
    "object": "whatsapp_business_account",
    "entry": [
        {
            "changes": [
                {
                    "value": {
                        "messages": [
                            {
                                "from": "5541999999999",
                                "id": "wamid.e2e",
                                "type": "text",
                                "timestamp": "1757000000",
                                "text": {"body": "gastei 47,50 no mercado"},
                            }
                        ]
                    }
                }
            ]
        }
    ],
}


class Mundo:
    """Tudo que está fora do agente, observável pelo teste."""

    def __init__(self) -> None:
        self.persistidas: list[str] = []
        self.criados: dict[str, dict] = {}
        self.entregues: list[tuple[str, str]] = []
        self.recusa: BaseException | None = None


@pytest.fixture
def mundo(monkeypatch) -> Mundo:
    import src.consumers.inbound_consumer as inbound
    import src.services.message_processor as mp

    mundo = Mundo()

    class Audit:
        async def log_message_detailed(self, phone, direction, content, metadata=None):
            mundo.persistidas.append(content)
            return {"id": f"ai-{len(mundo.persistidas)}", "duplicate": False}

        async def log_message(self, *args, **kwargs):
            return "outbound"

        async def log_extraction(self, **kwargs):
            return "ext-1"

    class Contato:
        async def find_by_phone(self, phone):
            return {"userId": "u1", "profileType": "personal"}

    class Assinatura:
        async def evaluate(self, user_id):
            return True, None

    class Classificador:
        async def classify(self, message, context):
            return FinancialIntent(
                intent=IntentType.create_transaction,
                transaction_type=TransactionTypeEnum.expense,
                amount=47.5,
                description="mercado",
                category_name="Mercado",
                confidence=0.95,
            )

    class Lancamentos:
        async def create_from_intent(self, intent, user_id, raw, **kwargs):
            chave = kwargs["idempotency_key"]
            mundo.criados.setdefault(chave, {"amount": intent.amount})
            return {"ok": True, "message": "Lançamento criado!"}

    class WhatsApp:
        async def send(self, phone, text):
            if mundo.recusa is not None:
                raise mundo.recusa
            mundo.entregues.append((phone, text))

    async def contexto(self, user_id, contact, phone):
        return {"categories": ["Mercado"], "accounts": ["Carteira"], "recent_messages": []}

    monkeypatch.setattr(inbound, "audit_service", Audit())
    monkeypatch.setattr(mp, "audit_service", Audit())
    monkeypatch.setattr(mp, "contact_service", Contato())
    monkeypatch.setattr(mp, "subscription_gate", Assinatura())
    monkeypatch.setattr(mp, "intent_classifier", Classificador())
    monkeypatch.setattr(mp, "transaction_creator", Lancamentos())
    monkeypatch.setattr(mp, "messenger", WhatsApp())
    monkeypatch.setattr(mp.MessageProcessor, "_build_context", contexto)

    # Sem esperar os 5s do debounce nem o tick de 1s do flusher.
    monkeypatch.setattr(settings, "message_buffer_debounce_seconds", 0)
    monkeypatch.setattr(settings, "worker_poll_interval_seconds", 0.01)
    monkeypatch.setattr(settings, "run_dlq_catalog_consumer", False)
    return mundo


@pytest.fixture
async def pipeline_no_ar(mundo):
    await pipeline.start_consumers()
    try:
        yield pipeline
    finally:
        await pipeline.stop()


async def postar_webhook() -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://agente") as client:
        return await client.post("/webhook/whatsapp", json=WEBHOOK)


async def esperar(condicao, timeout: float = 3.0) -> None:
    prazo = asyncio.get_running_loop().time() + timeout
    while not condicao():
        if asyncio.get_running_loop().time() > prazo:
            raise AssertionError("o pipeline não chegou ao estado esperado a tempo")
        await asyncio.sleep(0.02)


async def test_mensagem_do_webhook_vira_lancamento_e_resposta(pipeline_no_ar, mundo):
    resposta = await postar_webhook()

    assert resposta.status_code == 202
    await esperar(lambda: mundo.entregues)

    assert mundo.persistidas == ["gastei 47,50 no mercado"]
    assert len(mundo.criados) == 1
    assert mundo.entregues == [(PHONE, "Lançamento criado!")]


async def test_recusa_do_whatsapp_isola_a_entrega_sem_perder_o_lancamento(
    pipeline_no_ar, mundo, broker
):
    """O incidente, com as correções e com a entrega assíncrona (P3).

    Antes de tudo, a recusa da Meta virava um ``warning``, o job era marcado
    como concluído e o usuário não recebia nada. Depois, a recusa derrubava o
    **job inteiro** na DLQ — nada se perdia, mas um problema de entrega ficava
    misturado com problema de processamento, e reprocessar refazia um trabalho
    que já tinha efeito.

    Agora as duas metades são separadas: o processamento conclui e é ackado (o
    lançamento está criado, a confirmação pendente já foi consumida), e o que
    falha é só a entrega — numa fila própria, com DLQ própria, reprocessável
    sozinha.
    """
    mundo.recusa = PermanentError("WhatsApp Cloud API recusou envio: HTTP 401")

    assert (await postar_webhook()).status_code == 202
    await esperar(lambda: broker.dlq)

    envelope = broker.dlq[0]
    assert envelope.source_queue == "outbound"
    assert envelope.permanent is True
    assert len(mundo.criados) == 1  # o lançamento existe; só a entrega falhou

    # O job foi concluído: refazê-lo não traria nada de volta, e traria o risco
    # de repetir efeito. O que sobrou para reprocessar é a mensagem de saída.
    job_id = envelope.payload["jobId"]
    assert await get_state_store().exists(f"job:done:{job_id}") is True
    assert envelope.payload["phone"] == PHONE


async def test_falha_de_entrega_nao_gera_aviso_pelo_canal_que_caiu(
    pipeline_no_ar, mundo, broker, monkeypatch
):
    """Aviso de DLQ vinda da fila de saída é suprimido.

    O aviso é uma mensagem de WhatsApp, entregue pela mesma fila que acabou de
    falhar: ele falharia igual, cairia na DLQ e geraria outro aviso. Quem
    precisa saber que a entrega parou é o operador, pelo painel e pelo alerta de
    profundidade — não o usuário, por um canal fora do ar.
    """
    mundo.recusa = PermanentError("WhatsApp Cloud API recusou envio: HTTP 401")
    assert (await postar_webhook()).status_code == 202
    await esperar(lambda: broker.dlq)
    envelope = broker.dlq[0]

    import src.consumers.dlq_catalog_consumer as catalogo

    class Catalogo:
        def __init__(self) -> None:
            self.capturadas: list[dict] = []

        async def capture(self, **kwargs):
            self.capturadas.append(kwargs)
            return {"id": "falha-1", "duplicate": False}

    registro = Catalogo()
    monkeypatch.setattr(catalogo, "failure_catalog", registro)
    mundo.recusa = None
    mundo.entregues.clear()

    await DlqCatalogMessageConsumer("whatsapp.outbound.dlq", "outbound.dlq").handle(
        BrokerMessage(
            body=envelope.model_dump_json(by_alias=True).encode(),
            routing_key="outbound.dlq",
        )
    )

    # Catalogada para o operador, e rotulada como falha de entrega.
    assert len(registro.capturadas) == 1
    assert registro.capturadas[0]["source"] == "whatsapp_outbound"
    # E nenhuma mensagem nova para o usuário.
    assert mundo.entregues == []


async def test_falha_de_processamento_continua_avisando_o_usuario(
    pipeline_no_ar, mundo, monkeypatch
):
    """A supressão vale só para a fila de saída, não para a de processamento.

    Uma mensagem que nunca chegou a ser processada continua sendo silêncio do
    ponto de vista do usuário — e é esse silêncio que o aviso existe para
    quebrar.
    """
    import src.consumers.dlq_catalog_consumer as catalogo

    class Catalogo:
        async def capture(self, **kwargs):
            return {"id": "falha-1", "duplicate": False}

    monkeypatch.setattr(catalogo, "failure_catalog", Catalogo())

    envelope = catalogo.DlqEnvelopeV1(
        payload={"phone": PHONE, "jobId": "job-1"},
        sourceQueue="whatsapp.processing.dlq",
        routingKey="processing.dlq",
        attempts=5,
        errorType="TimeoutError",
        errorMessage="API principal fora",
    )

    await DlqCatalogMessageConsumer("whatsapp.processing.dlq", "processing.dlq").handle(
        BrokerMessage(
            body=envelope.model_dump_json(by_alias=True).encode(),
            routing_key="processing.dlq",
        )
    )

    # O aviso também passa pela fila de saída: por isso a espera. Quando o
    # canal está de pé, essa volta extra não muda nada para o usuário — e é o
    # que garante que exista um ponto só por onde toda resposta sai.
    await esperar(lambda: mundo.entregues)

    assert len(mundo.entregues) == 1
    phone, texto = mundo.entregues[0]
    assert phone == PHONE
    assert "problema para processar" in texto


async def test_readiness_enxerga_o_flusher(pipeline_no_ar):
    pronto, detalhes = await pipeline.readiness()
    assert pronto is True
    assert detalhes["flusher"] == "up"

    # Flusher parado com os consumers de pé: texto seria ackado e ficaria preso
    # no agrupamento, sem fila crescendo nem DLQ acendendo.
    await pipeline.flusher.stop()

    pronto, detalhes = await pipeline.readiness()
    assert pronto is False
    assert detalhes["flusher"] == "down"
    assert json.dumps(detalhes)  # continua serializável para o /health/ready
