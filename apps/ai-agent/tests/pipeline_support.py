"""O mundo fora do agente, para os testes ponta a ponta do pipeline.

Compartilhado pelo e2e em memória (``test_pipeline_end_to_end.py``) e pela
versão com RabbitMQ e Redis reais (``test_pipeline_integration.py``): só o que
sai do processo é dublê — API principal, LLM e WhatsApp.
"""

from __future__ import annotations

import asyncio
import uuid

import httpx

from src.config import settings
from src.schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum

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
        # O `jobId` deriva dos ids persistidos, e no Redis real o `job:done`
        # dura 24h: ids fixos fariam o teste seguinte ser descartado como
        # duplicata.
        self.execucao = uuid.uuid4().hex[:8]
        self.persistidas: list[str] = []
        self.criados: dict[str, dict] = {}
        self.entregues: list[tuple[str, str]] = []
        self.recusa: BaseException | None = None


def instalar_mundo(monkeypatch) -> Mundo:
    import src.consumers.inbound_consumer as inbound
    import src.services.message_processor as mp

    mundo = Mundo()

    class Audit:
        async def log_message_detailed(self, phone, direction, content, metadata=None):
            mundo.persistidas.append(content)
            return {"id": f"ai-{mundo.execucao}-{len(mundo.persistidas)}", "duplicate": False}

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
        async def pending_question(self, intent, user_id):
            return None

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


async def postar_webhook() -> httpx.Response:
    from src.main import app

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://agente") as client:
        return await client.post("/webhook/whatsapp", json=WEBHOOK)


async def esperar(condicao, timeout: float = 3.0) -> None:
    """Espera ``condicao()`` ficar verdadeira. Aceita função síncrona ou assíncrona."""
    loop = asyncio.get_running_loop()
    prazo = loop.time() + timeout
    while True:
        resultado = condicao()
        if asyncio.iscoroutine(resultado):
            resultado = await resultado
        if resultado:
            return
        if loop.time() > prazo:
            raise AssertionError("o pipeline não chegou ao estado esperado a tempo")
        await asyncio.sleep(0.02)
