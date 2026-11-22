"""Baixa de contas em aberto e pagamento de fatura (docs/plans/018, Fase 2).

Conversas completas pelo ``process_job``, como em ``test_conversation_flows``:
o LLM é simulado e a API também, mas a conversa (lista, "sim", "não",
idempotência pelo ``jobId``) é o caminho real.
"""

from __future__ import annotations

import pytest

import src.services.message_processor as mp
from src.messaging.base import TransientError
from src.schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum
from src.services import action_processor as module
from src.services.conversation_manager import conversation_manager
from tests.test_conversation_flows import PHONE, despesa, mundo  # noqa: F401

LUZ = {
    "id": "t-luz",
    "description": "Luz",
    "categoryName": "Moradia",
    "remaining": 120,
    "dueDate": "2026-09-30",
    "isOverdue": False,
    "accountId": "acc-1",
    "accountName": "Itaú",
    "recurrenceType": None,
}
ALUGUEL = {
    **LUZ,
    "id": "t-aluguel",
    "description": "Aluguel",
    "remaining": 1800,
    "dueDate": "2026-10-01",
    "recurrenceType": "fixo",
}
AGUA = {**LUZ, "id": "t-agua", "description": "Conta de água", "remaining": 40}
SALARIO = {
    **LUZ,
    "id": "t-salario",
    "description": "Salário",
    "categoryName": "Salário",
    "remaining": 3000,
}
FATURA = {
    "invoiceId": "inv-1",
    "cardId": "card-1",
    "cardName": "Nubank",
    "remaining": 450,
    "dueDate": "2026-10-05",
    "isOverdue": False,
    "state": "closed",
}


class _Resposta:
    def __init__(self, status: int, body: dict) -> None:
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class Api:
    """O que o agente postou nas rotas de baixa e fatura."""

    def __init__(self) -> None:
        self.posts: list[tuple[str, dict]] = []
        self.resposta: _Resposta | Exception = _Resposta(201, {"id": "s1"})

    async def post(self, path, json):
        self.posts.append((path, json))
        if isinstance(self.resposta, Exception):
            raise self.resposta
        return self.resposta


@pytest.fixture
def baixa(mundo, monkeypatch):  # noqa: F811
    """Liga ``whatsapp_payments``: itens em aberto, catálogo e API simulados."""
    mundo.contas[0]["cardId"] = "card-1"
    aberto = {"expense": {"entries": [LUZ, ALUGUEL], "invoices": [FATURA]}}
    aberto["income"] = {"entries": [SALARIO], "invoices": []}

    async def open_items(user_id, kind):
        return aberto[kind]

    class Catalogo:
        async def accounts(self, user_id):
            return mundo.contas

    api = Api()
    monkeypatch.setattr(module, "_open_items", open_items)
    monkeypatch.setattr(module, "user_catalog", Catalogo())
    monkeypatch.setattr(module, "api_client", api)
    mundo.aberto = aberto
    mundo.api = api
    return mundo


def baixa_de(**campos) -> FinancialIntent:
    base = dict(
        intent=IntentType.settle_bill,
        transaction_type=TransactionTypeEnum.expense,
        description="luz",
        confidence=0.9,
    )
    base.update(campos)
    return FinancialIntent(**base)


async def pendente():
    return await conversation_manager.get(PHONE)


# ── Dar baixa ────────────────────────────────────────────────────────────────
async def test_baixa_mostra_o_que_vai_acontecer_e_so_executa_com_sim(baixa):
    baixa.llm["marca a luz como paga"] = baixa_de()

    pergunta = await baixa.enviar("marca a luz como paga")

    assert pergunta.startswith(
        "Marcar como paga *Luz — R$ 120,00* (vence 30/09), saindo da conta Itaú, em 27/09?"
    )
    assert pergunta.endswith("Responda *sim* ou *não*.")
    assert baixa.api.posts == []

    resposta = await baixa.enviar("sim")

    assert resposta == "✅ Pronto! *Luz* marcada como paga, saindo da conta Itaú, em 27/09."
    # O jobId do "sim" é a chave: um retry do mesmo job não paga de novo.
    assert baixa.api.posts == [
        (
            "/internal/users/u1/transactions/t-luz/settlements",
            {"date": "2026-09-27", "idempotencyKey": "job-2"},
        )
    ]
    assert baixa.enviados == []  # nenhum lançamento novo
    assert (await pendente()).pending_action is None


async def test_nao_cancela_sem_mexer_em_nada(baixa):
    baixa.llm["marca a luz como paga"] = baixa_de()

    await baixa.enviar("marca a luz como paga")
    assert await baixa.enviar("não") == module.NOTHING_DONE
    assert baixa.api.posts == []
    assert (await pendente()).awaiting_confirmation is False


async def test_varias_parecidas_viram_lista_numerada(baixa):
    baixa.aberto["expense"]["entries"] = [LUZ, AGUA, ALUGUEL]
    baixa.llm["paguei a conta"] = baixa_de(description=None)

    lista = await baixa.enviar("paguei a conta")

    assert lista.splitlines()[0] == "Qual destas você pagou?"
    assert "2. Conta de água — R$ 40,00 — vence 30/09" in lista
    confirmacao = await baixa.enviar("2")
    assert "*Conta de água — R$ 40,00*" in confirmacao
    await baixa.enviar("sim")
    assert baixa.api.posts[0][0] == "/internal/users/u1/transactions/t-agua/settlements"


async def test_a_lista_tambem_aceita_o_nome(baixa):
    baixa.aberto["expense"]["entries"] = [LUZ, AGUA]
    baixa.llm["paguei a conta"] = baixa_de(description=None)

    await baixa.enviar("paguei a conta")
    confirmacao = await baixa.enviar("a da água")

    assert "*Conta de água — R$ 40,00*" in confirmacao


async def test_baixa_parcial_diz_quanto_falta(baixa):
    baixa.llm["paguei 50 da luz"] = baixa_de(amount=50)

    pergunta = await baixa.enviar("paguei 50 da luz")
    assert "Registrar pagamento de R$ 50,00 em *Luz* (em aberto: R$ 120,00)" in pergunta
    assert "Vão faltar R$ 70,00." in pergunta

    resposta = await baixa.enviar("sim")

    assert baixa.api.posts[0][1]["amount"] == 50
    assert resposta.endswith("Ainda faltam R$ 70,00.")


async def test_valor_acima_do_que_falta_propoe_quitar_o_restante(baixa):
    baixa.llm["paguei 150 da luz"] = baixa_de(amount=150)

    pergunta = await baixa.enviar("paguei 150 da luz")
    assert pergunta.startswith("*Luz* tem R$ 120,00 em aberto e você disse R$ 150,00.")

    await baixa.enviar("sim")
    assert "amount" not in baixa.api.posts[0][1]


async def test_no_fixo_o_valor_maior_e_o_valor_real(baixa):
    baixa.llm["paguei 1900 do aluguel"] = baixa_de(description="aluguel", amount=1900)

    pergunta = await baixa.enviar("paguei 1900 do aluguel")
    assert "pelo valor de R$ 1.900,00 (previsto: R$ 1.800,00)" in pergunta
    await baixa.enviar("sim")
    assert baixa.api.posts[0][1]["amount"] == 1900


async def test_recebimento_usa_as_palavras_da_receita(baixa):
    baixa.llm["recebi o salário"] = baixa_de(
        transaction_type=TransactionTypeEnum.income, description="salário"
    )

    pergunta = await baixa.enviar("recebi o salário")
    assert pergunta.startswith("Marcar como recebida *Salário — R$ 3.000,00*")
    assert "entrando na conta Itaú" in pergunta


async def test_nada_em_aberto_com_esse_nome_vira_lancamento_novo(baixa):
    baixa.llm["paguei a netflix"] = baixa_de(description="netflix")

    resposta = await baixa.enviar("paguei a netflix")

    assert resposta.startswith(
        "Não encontrei *netflix* em aberto, então vou registrar como um gasto novo.\n"
    )
    assert "Não identifiquei o valor" in resposta


async def test_flag_desligada_segue_como_antes(mundo):  # noqa: F811
    mundo.llm["marca a luz como paga"] = baixa_de(amount=120, category_name="Mercado")

    resposta = await mundo.enviar("marca a luz como paga")

    # Sem a Fase 2, a mensagem vira o lançamento de sempre.
    assert "Lançamento criado!" in resposta
    assert mundo.payload["amount"] == 120


async def test_api_recusa_e_a_mensagem_dela_chega_ao_usuario(baixa):
    baixa.llm["marca a luz como paga"] = baixa_de()
    baixa.api.resposta = _Resposta(409, {"message": "Este lançamento já está liquidado."})

    await baixa.enviar("marca a luz como paga")
    resposta = await baixa.enviar("sim")

    assert resposta == "Não consegui registrar: Este lançamento já está liquidado."
    assert (await pendente()).pending_action is None


async def test_queda_da_api_no_sim_mantem_a_pergunta_para_o_retry(baixa):
    baixa.llm["marca a luz como paga"] = baixa_de()
    baixa.api.resposta = ConnectionError()

    await baixa.enviar("marca a luz como paga")
    with pytest.raises(TransientError):
        await baixa.enviar("sim")

    # O job é retentado com o mesmo jobId; a pergunta continua de pé.
    assert (await pendente()).pending_action["step"] == module.STEP_CONFIRM


async def test_mensagem_nova_no_meio_da_lista_e_processada(baixa):
    baixa.aberto["expense"]["entries"] = [LUZ, AGUA]
    baixa.llm["paguei a conta"] = baixa_de(description=None)
    baixa.llm["gastei 30 no uber"] = despesa(
        amount=30, description="uber", category_name="Transporte"
    )

    await baixa.enviar("paguei a conta")
    resposta = await baixa.enviar("gastei 30 no uber")

    assert resposta.startswith(mp.DISCARDED_ACTION_NOTICE)
    assert "Despesa de R$ 30,00 em Transporte" in resposta
    assert baixa.api.posts == []


# ── Oferta de baixa ao criar ─────────────────────────────────────────────────
async def test_gasto_que_quita_conta_em_aberto_pergunta_antes(baixa):
    baixa.llm["paguei 120 de luz"] = despesa(
        amount=120, description="luz", category_name="Mercado", account_name="Itaú"
    )

    oferta = await baixa.enviar("paguei 120 de luz")

    assert oferta.startswith(
        "Você tem *Luz — R$ 120,00* em aberto (vence 30/09). É o pagamento dela?"
    )
    assert baixa.enviados == []

    resposta = await baixa.enviar("sim")

    assert resposta.startswith("✅ Pronto! *Luz* marcada como paga")
    assert baixa.enviados == []  # não duplicou
    assert baixa.api.posts[0][1]["accountId"] == "acc-1"


async def test_nao_a_oferta_cria_o_gasto_sem_perguntar_de_novo(baixa):
    baixa.llm["paguei 120 de luz"] = despesa(
        amount=120, description="luz", category_name="Mercado", account_name="Itaú"
    )

    await baixa.enviar("paguei 120 de luz")
    resposta = await baixa.enviar("não")

    assert "Lançamento criado! Despesa de R$ 120,00" in resposta
    assert baixa.payload["amount"] == 120
    assert baixa.payload["rawInput"] == "paguei 120 de luz"
    assert baixa.api.posts == []


async def test_gasto_no_cartao_nao_oferece_baixa(baixa):
    baixa.llm["paguei 120 de luz no nubank"] = despesa(
        amount=120,
        description="luz",
        category_name="Mercado",
        account_name="Nubank (cartão de crédito)",
    )

    resposta = await baixa.enviar("paguei 120 de luz no nubank")

    assert "Lançamento criado!" in resposta


async def test_valor_diferente_nao_oferece_baixa(baixa):
    baixa.llm["paguei 80 de luz"] = despesa(
        amount=80, description="luz", category_name="Mercado", account_name="Itaú"
    )

    assert "Lançamento criado!" in await baixa.enviar("paguei 80 de luz")


# ── Fatura ───────────────────────────────────────────────────────────────────
def fatura_de(**campos) -> FinancialIntent:
    base = dict(intent=IntentType.pay_invoice, card_name="Nubank", confidence=0.9)
    base.update(campos)
    return FinancialIntent(**base)


async def test_fatura_pergunta_a_conta_e_confirma_antes_de_pagar(baixa):
    baixa.llm["paguei a fatura do nubank"] = fatura_de()

    lista = await baixa.enviar("paguei a fatura do nubank")
    assert lista.splitlines()[0] == "De qual conta saiu o pagamento?"
    assert "1. Itaú" in lista and "2. Carteira" in lista

    confirmacao = await baixa.enviar("1")
    assert confirmacao.startswith(
        "Registrar o pagamento de R$ 450,00 da fatura *Nubank* (vence 05/10), "
        "saindo da conta Itaú, em 27/09?"
    )

    resposta = await baixa.enviar("sim")

    assert resposta == (
        "✅ Pagamento de R$ 450,00 da fatura *Nubank* registrado, saindo da conta Itaú, "
        "em 27/09."
    )
    assert baixa.api.posts == [
        (
            "/internal/users/u1/cards/card-1/invoices/inv-1/payments",
            {
                "sourceAccountId": "acc-1",
                "amount": 450,
                "paymentDate": "2026-09-27",
                "idempotencyKey": "job-3",
            },
        )
    ]
    assert baixa.enviados == []  # pagar a fatura não é gasto


async def test_fatura_com_conta_preferencial_vai_direto_a_confirmacao(baixa):
    baixa.contas[1]["isPreferred"] = True
    baixa.llm["paguei 200 da fatura"] = fatura_de(card_name=None, amount=200)

    confirmacao = await baixa.enviar("paguei 200 da fatura")

    assert "Registrar o pagamento de R$ 200,00 da fatura *Nubank*" in confirmacao
    assert "Vão faltar R$ 250,00 na fatura." in confirmacao
    resposta = await baixa.enviar("sim")
    assert resposta.endswith("Ainda faltam R$ 250,00 nessa fatura.")


async def test_fatura_sem_saldo(baixa):
    baixa.aberto["expense"]["invoices"] = []
    baixa.llm["paguei a fatura do nubank"] = fatura_de()

    resposta = await baixa.enviar("paguei a fatura do nubank")

    assert resposta == "A fatura do Nubank não tem nada em aberto. 🎉"


async def test_fatura_com_flag_desligada_manda_para_o_app(mundo):  # noqa: F811
    mundo.llm["paguei a fatura do nubank"] = fatura_de()

    resposta = await mundo.enviar("paguei a fatura do nubank")

    assert resposta == module.INVOICE_UNAVAILABLE
    assert mundo.enviados == []


async def test_gasto_com_valor_sem_conta_em_aberto_segue_sem_aviso(baixa):
    # O LLM às vezes classifica "paguei 120 de luz" como baixa; sem Luz em
    # aberto, é só um gasto e não ganha "Não encontrei…".
    baixa.aberto["expense"]["entries"] = [{**AGUA, "remaining": 120}]
    baixa.llm["paguei 120 de luz"] = baixa_de(amount=120, category_name="Mercado")

    resposta = await baixa.enviar("paguei 120 de luz")

    assert resposta.startswith("Lançamento criado! Despesa de R$ 120,00")
    assert baixa.api.posts == []
