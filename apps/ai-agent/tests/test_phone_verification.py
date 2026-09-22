"""Verificação de posse do número pelo código enviado ao bot (segurança, S1.1).

O app mostra um código; o usuário o envia ao bot a partir do número que quer
vincular. O agente reconhece o código e pergunta à API se ele confere. Número
só declarado não identifica ninguém, e uma confirmação pendente não sobrevive à
troca de dono do número (regra C4 do plano).
"""

from __future__ import annotations

import httpx
import pytest

import src.services.message_processor as mp
from src.messaging.base import TransientError
from src.schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum
from src.services import phone_verification as pv
from src.services.conversation_store import ConversationState
from src.services.phone_verification import (
    ALREADY_LINKED_MESSAGE,
    EXPIRED_CODE_MESSAGE,
    INVALID_CODE_MESSAGE,
    NO_PENDING_CODE_MESSAGE,
    PhoneVerificationService,
    extract_verification_code,
)

PHONE = "+5519999999999"
PREFILLED = "Olá! Quero ativar meu WhatsApp no Financial Vellun. Código: 048213"


# ── Reconhecimento do código ─────────────────────────────────────────────────
@pytest.mark.parametrize(
    ("texto", "codigo", "rotulado"),
    [
        (PREFILLED, "048213", True),
        ("codigo 048213", "048213", True),
        ("Meu CÓDIGO é: 048213, obrigado", "048213", True),
        (" 048213 ", "048213", False),
    ],
)
def test_reconhece_codigo(texto, codigo, rotulado):
    found = extract_verification_code(texto)
    assert found is not None
    assert (found.value, found.labeled) == (codigo, rotulado)


@pytest.mark.parametrize(
    "texto",
    ["paguei 150000 no carro", "gastei 50 no mercado", "código 12345", "0482139"],
)
def test_ignora_o_que_nao_e_codigo(texto):
    assert extract_verification_code(texto) is None


# ── Conversa com a API ───────────────────────────────────────────────────────
class FakeApi:
    def __init__(self, resposta=None, erro=None):
        self.resposta = resposta
        self.erro = erro
        self.chamadas: list[tuple[str, dict]] = []

    async def post(self, path, **kwargs):
        self.chamadas.append((path, kwargs.get("json")))
        if self.erro is not None:
            raise self.erro
        return self.resposta


@pytest.fixture
def api(monkeypatch):
    fake = FakeApi()
    monkeypatch.setattr(pv, "api_client", fake)
    return fake


async def test_codigo_certo_responde_boas_vindas(api):
    api.resposta = httpx.Response(200, json={"status": "verified", "name": "Joao Grilo"})

    outcome = await PhoneVerificationService().confirm(PHONE, "048213")

    assert api.chamadas == [("/internal/whatsapp/verify", {"phone": PHONE, "code": "048213"})]
    assert outcome.status == "verified"
    assert outcome.reply.startswith("Olá, Joao!")


@pytest.mark.parametrize(
    ("status", "mensagem"),
    [("invalid_code", INVALID_CODE_MESSAGE), ("expired", EXPIRED_CODE_MESSAGE)],
)
async def test_codigo_recusado_explica_o_motivo(api, status, mensagem):
    api.resposta = httpx.Response(200, json={"status": status})

    outcome = await PhoneVerificationService().confirm(PHONE, "048213")

    assert outcome.reply == mensagem


async def test_sem_desafio_nao_decide_a_resposta(api):
    api.resposta = httpx.Response(200, json={"status": "not_found"})

    outcome = await PhoneVerificationService().confirm(PHONE, "048213")

    assert outcome.reply is None


@pytest.mark.parametrize("status", [401, 500, 503])
async def test_falha_da_api_e_transitoria(api, status):
    # Queda da API nunca pode virar "código inválido" para o usuário.
    api.resposta = httpx.Response(status)

    with pytest.raises(TransientError):
        await PhoneVerificationService().confirm(PHONE, "048213")


# ── Fluxo no processamento ───────────────────────────────────────────────────
class FakeVerification:
    def __init__(self, status="not_found", reply=None):
        self.outcome = pv.VerificationOutcome(status, reply)
        self.calls: list[str] = []

    async def confirm(self, phone, code):
        self.calls.append(code)
        return self.outcome


class FakeContact:
    def __init__(self, contact):
        self.contact = contact

    async def find_by_phone(self, phone):
        return self.contact


class FakeGate:
    async def evaluate(self, user_id):
        return (True, None)


class FakeClassifier:
    def __init__(self):
        self.messages: list[str] = []

    async def classify(self, message, context):
        self.messages.append(message)
        return FinancialIntent(intent=IntentType.help, confidence=0.9)

    def classify_with_rules(self, reply):
        return FinancialIntent(intent=IntentType.unknown, confidence=0.1)


class FakeTxCreator:
    def __init__(self):
        self.users: list[str] = []

    async def create_from_intent(self, intent, user_id, raw, **kwargs):
        self.users.append(user_id)
        return {"ok": True, "message": "Lançamento criado"}


class FakeAudit:
    async def log_message(self, *a, **k):
        return "msg"

    async def log_extraction(self, *a, **k):
        return "ext"


@pytest.fixture
def pipeline(monkeypatch):
    """Substitui as dependências do ``message_processor`` por fakes."""

    def montar(contact=None, verification=None):
        fakes = {
            "contact_service": FakeContact(contact),
            "phone_verification_service": verification or FakeVerification(),
            "subscription_gate": FakeGate(),
            "intent_classifier": FakeClassifier(),
            "transaction_creator": FakeTxCreator(),
            "audit_service": FakeAudit(),
        }
        for name, value in fakes.items():
            monkeypatch.setattr(mp, name, value)

        async def contexto(self, user_id, contact, phone):
            return {"categories": ["Mercado"], "recent_messages": []}

        monkeypatch.setattr(mp.MessageProcessor, "_build_context", contexto)
        return fakes

    return montar


async def processar(texto: str) -> str:
    return await mp.message_processor.process_job(
        mp.ProcessingJobV1(
            job_id="00000000-0000-0000-0000-000000000001",
            phone=PHONE,
            combined_message=texto,
            source_message_ids=["m1"],
        )
    )


LINKED = {"userId": "u1", "profileType": "individual", "contactId": "c1", "linkVersion": 2}


async def test_numero_novo_envia_codigo_e_recebe_boas_vindas(pipeline):
    fakes = pipeline(contact=None, verification=FakeVerification("verified", "Bem-vindo!"))

    assert await processar(PREFILLED) == "Bem-vindo!"
    assert fakes["phone_verification_service"].calls == ["048213"]
    assert fakes["intent_classifier"].messages == []


async def test_numero_nao_vinculado_sem_desafio_orienta_a_gerar_codigo(pipeline):
    pipeline(contact=None, verification=FakeVerification("not_found", None))

    assert await processar(PREFILLED) == NO_PENDING_CODE_MESSAGE


async def test_codigo_reenviado_por_numero_ja_vinculado_nao_vai_ao_llm(pipeline):
    fakes = pipeline(contact=LINKED, verification=FakeVerification("not_found", None))

    assert await processar(PREFILLED) == ALREADY_LINKED_MESSAGE
    assert fakes["intent_classifier"].messages == []


async def test_numero_solto_de_quem_ja_tem_vinculo_segue_para_o_llm(pipeline):
    # "150000" pode ser a resposta a "qual o valor?": não é código.
    fakes = pipeline(contact=LINKED)

    await processar("150000")

    assert fakes["phone_verification_service"].calls == []
    assert fakes["intent_classifier"].messages == ["150000"]


async def test_numero_solto_vale_como_codigo_para_numero_sem_vinculo(pipeline):
    fakes = pipeline(contact=None, verification=FakeVerification("verified", "Bem-vindo!"))

    assert await processar("048213") == "Bem-vindo!"
    assert fakes["phone_verification_service"].calls == ["048213"]


def _pending() -> FinancialIntent:
    return FinancialIntent(
        intent=IntentType.create_transaction,
        transaction_type=TransactionTypeEnum.expense,
        amount=50,
        description="mercado",
        category_name="Mercado",
        transaction_date="2026-09-22",
        confidence=0.6,
        needs_confirmation=True,
    )


async def test_confirmacao_pendente_e_descartada_quando_o_numero_troca_de_dono(pipeline):
    # Pergunta feita ao dono anterior (linkVersion 1); o número agora é de
    # outra conta (linkVersion 2). O "sim" não pode criar o lançamento.
    await mp.conversation_manager.set_pending(
        PHONE, _pending(), {"userId": "antigo", "contactId": "c1", "linkVersion": 1}
    )
    fakes = pipeline(contact=LINKED)

    await processar("sim")

    assert fakes["transaction_creator"].users == []
    assert fakes["intent_classifier"].messages == ["sim"]
    state = await mp.conversation_manager.get(PHONE)
    assert state.awaiting_confirmation is False


async def test_confirmacao_pendente_do_mesmo_vinculo_e_concluida(pipeline):
    await mp.conversation_manager.set_pending(PHONE, _pending(), LINKED)
    fakes = pipeline(contact=LINKED)

    assert await processar("sim") == "Lançamento criado"
    assert fakes["transaction_creator"].users == ["u1"]


def test_estado_sem_vinculo_nao_pertence_a_ninguem():
    assert ConversationState(pending_intent=_pending()).belongs_to(LINKED) is False
