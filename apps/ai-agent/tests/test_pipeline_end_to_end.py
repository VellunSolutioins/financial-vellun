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
from src.messaging.contracts import ProcessingJobV1
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


async def test_recusa_do_whatsapp_chega_na_dlq_e_o_usuario_e_avisado(
    pipeline_no_ar, mundo, broker, monkeypatch
):
    """O incidente, com as correções: a falha deixa de ser silêncio.

    Antes, a recusa da Meta virava um ``warning``, o job era marcado como
    concluído e o usuário não recebia nada. Agora o job cai na DLQ sem ser dado
    como concluído, e o catálogo de falhas avisa o usuário assim que o envio
    volta a funcionar.
    """
    mundo.recusa = PermanentError("WhatsApp Cloud API recusou envio: HTTP 401")

    assert (await postar_webhook()).status_code == 202
    await esperar(lambda: broker.dlq)

    envelope = broker.dlq[0]
    assert envelope.source_queue == "processing"
    assert envelope.permanent is True
    assert len(mundo.criados) == 1  # o lançamento existe; só a entrega falhou
    job = ProcessingJobV1.model_validate(envelope.payload)
    assert await get_state_store().exists(f"job:done:{job.job_id}") is False

    # O catálogo de falhas (no RabbitMQ, um consumer da DLQ) recebe o envelope.
    import src.consumers.dlq_catalog_consumer as catalogo

    class Catalogo:
        async def capture(self, **kwargs):
            return {"id": "falha-1", "duplicate": False}

    monkeypatch.setattr(catalogo, "failure_catalog", Catalogo())
    mundo.recusa = None
    await DlqCatalogMessageConsumer("whatsapp.processing.dlq", "processing.dlq").handle(
        BrokerMessage(
            body=envelope.model_dump_json(by_alias=True).encode(),
            routing_key="processing.dlq",
        )
    )

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
