"""Conversas completas: mensagem → perguntas → respostas → lançamento na API.

O LLM é simulado (um dicionário mensagem → intent), mas o resto é o caminho
real: ``process_job``, regras de confirmação, estado pendente, fusão das
respostas e ``transaction_creator`` montando o payload de
``/internal/transactions/from-ai``. Cobre os gaps da análise do webhook:
intenção, conta/cartão, recorrência, categoria e data.
"""

from __future__ import annotations

from datetime import datetime, timezone
from itertools import count

import pytest

import src.services.message_processor as mp
from src.messaging.contracts import ProcessingJobV1
from src.schemas.financial_intent import (
    AccountKindEnum,
    AmountBasisEnum,
    FinancialIntent,
    IntentType,
    RecurrenceFrequencyEnum,
    RecurrenceTypeEnum,
    TransactionTypeEnum,
)
from src.services import transaction_creator as creator_module
from src.services.conversation_manager import conversation_manager
from src.services.intent_classifier import IntentClassifier
from src.services.transaction_creator import display_name

PHONE = "+5541999990000"
CONTACT = {"userId": "u1", "profileType": "individual", "contactId": "c1", "linkVersion": 1}
# 12h em Brasília, domingo 27/09/2026.
RECEBIDA = datetime(2026, 9, 27, 15, 0, tzinfo=timezone.utc)

CONTAS = [
    {"id": "card-acc", "name": "Nubank", "kind": "card"},
    {"id": "acc-1", "name": "Itaú", "kind": "account"},
    {"id": "acc-2", "name": "Carteira", "kind": "account"},
]
CATEGORIAS = [
    {"id": "cat-mercado", "name": "Mercado", "type": "expense"},
    {"id": "cat-transporte", "name": "Transporte", "type": "expense"},
    {"id": "cat-outros", "name": "Outros", "type": "expense"},
    {"id": "cat-salario", "name": "Salário", "type": "income"},
]


def despesa(**overrides) -> FinancialIntent:
    base = dict(
        intent=IntentType.create_transaction,
        transaction_type=TransactionTypeEnum.expense,
        amount=50,
        description="mercado",
        category_name="Mercado",
        transaction_date="2026-09-27",
        confidence=0.95,
    )
    base.update(overrides)
    return FinancialIntent(**base)


class Mundo:
    def __init__(self) -> None:
        self.contas = [dict(c) for c in CONTAS]
        self.categorias = [dict(c) for c in CATEGORIAS]
        #: O que o "LLM" devolve para cada mensagem nova.
        self.llm: dict[str, FinancialIntent] = {}
        self.llm_contextos: list[dict] = []
        self.enviados: list[dict] = []
        self._ids = count(1)

    async def enviar(self, texto: str, recebida: datetime = RECEBIDA) -> str:
        job = ProcessingJobV1(
            job_id=f"job-{next(self._ids)}",
            phone=PHONE,
            combined_message=texto,
            source_message_ids=["m1"],
            first_received_at=recebida,
        )
        return await mp.message_processor.process_job(job)

    @property
    def payload(self) -> dict:
        assert len(self.enviados) == 1, self.enviados
        return self.enviados[0]


@pytest.fixture
def mundo(monkeypatch) -> Mundo:
    m = Mundo()

    class Contato:
        async def find_by_phone(self, phone):
            return CONTACT

    class Assinatura:
        async def evaluate(self, user_id):
            return True, None

    class Llm:
        async def classify(self, message, context):
            m.llm_contextos.append(context)
            return m.llm.get(message, FinancialIntent(intent=IntentType.unknown)).model_copy(
                deep=True
            )

    class Auditoria:
        async def log_extraction(self, **kwargs):
            return "ext-1"

        async def log_message(self, *args, **kwargs):
            return "msg-1"

    class Catalogo:
        async def accounts(self, user_id):
            return m.contas

        async def categories(self, user_id):
            return m.categorias

    class Resposta:
        status_code = 201
        text = ""

        def json(self):
            return {"id": "t1"}

    class Api:
        async def post(self, path, json):
            m.enviados.append(json)
            return Resposta()

    async def contexto(self, user_id, contact, phone):
        return {
            "today": "2000-01-01",  # o processador troca pelo dia da mensagem
            "categories": [c["name"] for c in m.categorias],
            "expense_categories": [c["name"] for c in m.categorias if c["type"] == "expense"],
            "income_categories": [c["name"] for c in m.categorias if c["type"] == "income"],
            "accounts": [display_name(c) for c in m.contas],
            "recent_messages": [],
        }

    monkeypatch.setattr(mp, "contact_service", Contato())
    monkeypatch.setattr(mp, "subscription_gate", Assinatura())
    monkeypatch.setattr(mp, "intent_classifier", Llm())
    monkeypatch.setattr(mp, "audit_service", Auditoria())
    monkeypatch.setattr(mp.MessageProcessor, "_build_context", contexto)
    monkeypatch.setattr(creator_module, "user_catalog", Catalogo())
    monkeypatch.setattr(creator_module, "api_client", Api())
    return m


async def pendente():
    return await conversation_manager.get(PHONE)


# ── Intenção ─────────────────────────────────────────────────────────────────
async def test_mensagem_sem_intencao_nao_vira_pergunta_de_valor(mundo):
    resposta = await mundo.enviar("oi, tudo bem?")

    assert resposta == mp.NOT_UNDERSTOOD_MESSAGE
    assert (await pendente()).awaiting_confirmation is False
    assert mundo.enviados == []


async def test_lancamento_novo_no_meio_da_pergunta_nao_sobrescreve_o_pendente(mundo):
    mundo.llm["gastei 50 no mercado"] = despesa(category_name=None)
    mundo.llm["gastei 30 no uber"] = despesa(
        amount=30, description="uber", category_name="Transporte"
    )

    pergunta = await mundo.enviar("gastei 50 no mercado")
    assert pergunta.startswith("Em qual categoria")

    resposta = await mundo.enviar("gastei 30 no uber")

    assert resposta.startswith("Deixei de lado o lançamento anterior de R$ 50,00 (mercado)")
    assert "Despesa de R$ 30,00 em Transporte" in resposta
    assert mundo.payload["amount"] == 30
    assert (await pendente()).awaiting_confirmation is False


async def test_negativa_cancela_o_pendente(mundo):
    mundo.llm["paguei 150000"] = despesa(amount=150_000)

    assert "alto" in await mundo.enviar("paguei 150000")
    assert await mundo.enviar("não") == mp.CANCELLED_MESSAGE
    assert mundo.enviados == []


async def test_sim_a_valor_alto_grava_em_vez_de_perguntar_de_novo(mundo):
    # Antes o "sim" voltava a cair na mesma pergunta, sem fim: nada acima de
    # R$ 100 mil entrava pelo WhatsApp.
    mundo.llm["paguei 150000"] = despesa(amount=150_000)

    assert "alto" in await mundo.enviar("paguei 150000")
    resposta = await mundo.enviar("sim")

    assert mundo.payload["amount"] == 150_000
    assert resposta.startswith("Lançamento criado!")


async def test_valor_alto_confirmado_nao_volta_a_ser_perguntado_depois_da_categoria(mundo):
    mundo.llm["paguei 150000"] = despesa(amount=150_000, category_name=None)

    assert "alto" in await mundo.enviar("paguei 150000")
    assert (await mundo.enviar("sim")).startswith("Em qual categoria")
    await mundo.enviar("mercado")

    assert mundo.payload["amount"] == 150_000
    assert mundo.payload["categoryId"] == "cat-mercado"


async def test_resposta_que_nao_responde_repete_a_pergunta_e_depois_desiste(mundo):
    mundo.llm["comprei parcelado"] = despesa(recurrence_type=RecurrenceTypeEnum.parcelado)

    assert (await mundo.enviar("comprei parcelado")).startswith("Em quantas parcelas")
    assert "de 2 a 72" in await mundo.enviar("sei lá")
    assert "de 2 a 72" in await mundo.enviar("hmm")
    assert await mundo.enviar("??") == mp.GAVE_UP_MESSAGE
    assert (await pendente()).awaiting_confirmation is False
    assert mundo.enviados == []


# ── Conta / cartão ───────────────────────────────────────────────────────────
async def test_sem_mencao_usa_a_conta_padrao(mundo):
    mundo.contas[2]["isPreferred"] = True
    mundo.llm["gastei 50 no mercado"] = despesa()

    resposta = await mundo.enviar("gastei 50 no mercado")

    assert mundo.payload["accountId"] == "acc-2"
    assert "na conta Carteira" in resposta


async def test_conta_citada_que_nao_existe_pergunta_e_a_resposta_define(mundo):
    mundo.llm["gastei 50 no bradesco"] = despesa(account_name="Bradesco")

    pergunta = await mundo.enviar("gastei 50 no bradesco")
    assert pergunta.startswith('Não encontrei "Bradesco"')
    assert mundo.enviados == []

    resposta = await mundo.enviar("no cartão nubank")

    assert mundo.payload["accountId"] == "card-acc"
    assert "no cartão Nubank" in resposta


async def test_no_cartao_sem_nome_usa_o_unico_cartao(mundo):
    mundo.llm["paguei 80 no cartão"] = despesa(amount=80, account_kind=AccountKindEnum.card)

    await mundo.enviar("paguei 80 no cartão")

    assert mundo.payload["accountId"] == "card-acc"


# ── Recorrência ──────────────────────────────────────────────────────────────
async def test_sem_recorrencia_cria_unica_vez(mundo):
    mundo.llm["gastei 50 no mercado"] = despesa()

    await mundo.enviar("gastei 50 no mercado")

    assert "recurrenceType" not in mundo.payload


async def test_recorrente_pergunta_repeticoes_e_cria_fixo(mundo):
    mundo.llm["netflix 55 todo mês"] = despesa(
        amount=55,
        description="netflix",
        category_name="Outros",
        recurrence_type=RecurrenceTypeEnum.fixo,
        recurrence_frequency=RecurrenceFrequencyEnum.monthly,
    )

    assert (await mundo.enviar("netflix 55 todo mês")).startswith("Quantas vezes")
    resposta = await mundo.enviar("12")

    assert mundo.payload["recurrenceType"] == "fixo"
    assert mundo.payload["recurrenceFrequency"] == "monthly"
    assert mundo.payload["recurrenceMonths"] == 12
    assert mundo.payload["rawInput"] == "netflix 55 todo mês"
    assert "fixa mensal de R$ 55,00" in resposta


async def test_recorrente_sem_frequencia_pergunta_e_recusa_semanal(mundo):
    mundo.llm["academia 100 recorrente"] = despesa(
        amount=100, category_name="Outros", recurrence_type=RecurrenceTypeEnum.fixo
    )

    assert (await mundo.enviar("academia 100 recorrente")).startswith("Com que frequência")
    assert (await mundo.enviar("semanal")).startswith("Por enquanto, lançamentos fixos")
    assert (await mundo.enviar("mensal")).startswith("Quantas vezes")
    await mundo.enviar("1 ano")

    assert mundo.payload["recurrenceMonths"] == 12


async def test_parcelado_completo_na_mensagem_cria_direto_com_o_total(mundo):
    mundo.llm["tv em 10x de 300 no nubank"] = despesa(
        amount=300,
        description="tv",
        category_name="Outros",
        account_name="Nubank (cartão de crédito)",
        recurrence_type=RecurrenceTypeEnum.parcelado,
        installments=10,
        amount_basis=AmountBasisEnum.installment,
    )

    resposta = await mundo.enviar("tv em 10x de 300 no nubank")

    assert mundo.payload["recurrenceType"] == "parcelado"
    assert mundo.payload["installments"] == 10
    assert mundo.payload["amount"] == 3000
    assert mundo.payload["accountId"] == "card-acc"
    assert "10x de R$ 300,00 (total R$ 3.000,00)" in resposta


async def test_llm_trocando_total_por_parcela_e_corrigido_e_outros_vira_pergunta(
    mundo, monkeypatch
):
    # Caso de produção: "gasto de 36,65 em 2x" gravou 2x de 36,65 (total 73,30),
    # em "Outros" sem perguntar. Aqui o classificador é o real, só o LLM é falso.
    class Provider:
        supports_vision = False

        async def extract_intent(self, message, context):
            return mundo.llm[message].model_copy(deep=True)

    monkeypatch.setattr(mp, "intent_classifier", IntentClassifier(provider=Provider()))
    mensagem = "Adicionar gasto de 36,65 em 2x no cartão nubank"
    mundo.llm[mensagem] = despesa(
        amount=36.65,
        description="gasto",
        category_name="Outros",
        account_name="Nubank (cartão de crédito)",
        recurrence_type=RecurrenceTypeEnum.parcelado,
        installments=2,
        amount_basis=AmountBasisEnum.installment,
    )

    assert (await mundo.enviar(mensagem)).startswith("Em qual categoria")
    resposta = await mundo.enviar("mercado")

    assert mundo.payload["amount"] == 36.65
    assert mundo.payload["installments"] == 2
    assert mundo.payload["categoryId"] == "cat-mercado"
    assert "2x de R$ 18,32 (total R$ 36,65)" in resposta


async def test_parcelado_alto_pelo_total_pergunta_e_o_sim_grava_o_total(mundo):
    mundo.llm["carro 3000 por parcela em 60x"] = despesa(
        amount=3000,
        description="carro",
        recurrence_type=RecurrenceTypeEnum.parcelado,
        installments=60,
        amount_basis=AmountBasisEnum.installment,
    )

    pergunta = await mundo.enviar("carro 3000 por parcela em 60x")
    assert pergunta.startswith("O valor total de R$ 180.000,00 (60x de R$ 3.000,00) é alto")
    assert mundo.enviados == []

    await mundo.enviar("sim")

    assert mundo.payload["amount"] == 180_000
    assert mundo.payload["installments"] == 60


async def test_parcelado_sem_parcelas_pergunta_parcelas_e_se_o_valor_e_total(mundo):
    mundo.llm["geladeira 3000 parcelado"] = despesa(
        amount=3000, category_name="Outros", recurrence_type=RecurrenceTypeEnum.parcelado
    )

    assert (await mundo.enviar("geladeira 3000 parcelado")).startswith("Em quantas parcelas")
    assert (await mundo.enviar("10")).startswith("R$ 3.000,00 é o valor total")
    await mundo.enviar("total")

    assert mundo.payload["installments"] == 10
    assert mundo.payload["amount"] == 3000


async def test_parcelado_respondido_a_vista_vira_unica_vez(mundo):
    mundo.llm["comprei parcelado"] = despesa(recurrence_type=RecurrenceTypeEnum.parcelado)

    await mundo.enviar("comprei parcelado")
    await mundo.enviar("foi à vista")

    assert "recurrenceType" not in mundo.payload


# ── Categoria ────────────────────────────────────────────────────────────────
async def test_sem_categoria_pergunta_com_opcoes_e_a_resposta_define(mundo):
    mundo.llm["paguei 300"] = despesa(amount=300, category_name=None)

    pergunta = await mundo.enviar("paguei 300")
    assert pergunta == (
        "Em qual categoria devo registrar esse lançamento? Mercado, Transporte, Outros"
    )

    resposta = await mundo.enviar("outros")

    assert mundo.payload["categoryId"] == "cat-outros"
    assert "em Outros" in resposta


async def test_categoria_de_receita_numa_despesa_vira_pergunta(mundo):
    mundo.llm["gastei 50"] = despesa(category_name="Salário")

    pergunta = await mundo.enviar("gastei 50")

    assert pergunta.startswith('Não encontrei a categoria "Salário"')
    assert mundo.enviados == []


# ── Data ─────────────────────────────────────────────────────────────────────
async def test_confirmacao_nao_troca_a_data_do_lancamento_por_hoje(mundo):
    mundo.llm["mercado 50 dia 20"] = despesa(transaction_date="2026-09-20", confidence=0.4)

    assert "confirma" in (await mundo.enviar("mercado 50 dia 20")).lower()
    await mundo.enviar("sim")

    assert mundo.payload["transactionDate"] == "2026-09-20"


async def test_resposta_a_pergunta_de_data_e_entendida(mundo):
    mundo.llm["gastei 50 no mercado semana passada"] = despesa()

    pergunta = await mundo.enviar("gastei 50 no mercado semana passada")
    assert pergunta.startswith("Em qual data")

    await mundo.enviar("17/09")

    assert mundo.payload["transactionDate"] == "2026-09-17"


async def test_hoje_e_o_dia_em_que_a_mensagem_chegou(mundo):
    # 23h30 de 27/09 em Brasília, já 28/09 em UTC.
    tarde = datetime(2026, 9, 28, 2, 30, tzinfo=timezone.utc)
    mundo.llm["gastei 50 no mercado"] = despesa(transaction_date=None)

    await mundo.enviar("gastei 50 no mercado", recebida=tarde)

    assert mundo.llm_contextos[0]["today"] == "2026-09-27"
    assert mundo.payload["transactionDate"] == "2026-09-27"


async def test_ontem_na_resposta_e_relativo_a_mensagem_original(mundo):
    mundo.llm["mercado 50 semana passada"] = despesa()

    await mundo.enviar("mercado 50 semana passada")
    # A resposta chega no dia seguinte; "ontem" continua sendo 26/09.
    await mundo.enviar("ontem", recebida=datetime(2026, 9, 28, 15, 0, tzinfo=timezone.utc))

    assert mundo.payload["transactionDate"] == "2026-09-26"
