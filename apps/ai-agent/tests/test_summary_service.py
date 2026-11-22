"""Resumo pelo WhatsApp (docs/plans/018, Fase 1): período, busca e resposta."""

from __future__ import annotations

from datetime import date

import pytest

from src.config import settings
from src.schemas.financial_intent import (
    FinancialIntent,
    IntentType,
    SummaryFocusEnum,
    TransactionTypeEnum,
)
from src.services import summary_service as module
from src.services.summary_service import (
    SUMMARY_ERROR_MESSAGE,
    SUMMARY_UNAVAILABLE_MESSAGE,
    format_summary,
    period_label,
    resolve_period,
    summary_service,
)

HOJE = date(2026, 11, 21)

PESSOAL = {
    "profileType": "individual",
    "period": {"start": "2026-11-01", "end": "2026-11-30"},
    "cashBalance": 1500,
    "spent": 820.5,
    "spentForecast": 120,
    "received": 3000,
    "toReceive": 200,
    "result": 2179.5,
    "byCategory": [
        {"name": "Mercado", "total": 500},
        {"name": "Transporte", "total": 300},
        {"name": "Lazer", "total": 15.5},
        {"name": "Pets", "total": 5},
    ],
    "byCategoryComplete": True,
    "commitments": {"until": "2026-11-30", "toPay": 900.25, "overdue": 110, "toReceive": 200},
    "upcoming": [
        {
            "description": "Fatura Nubank",
            "remaining": 450.25,
            "dueDate": "2026-11-25",
            "isOverdue": False,
            "kind": "invoice",
        },
        {
            "description": "Luz",
            "remaining": 110,
            "dueDate": "2026-11-10",
            "isOverdue": True,
            "kind": "bill",
        },
    ],
    "cardsDebt": 980,
}

EMPRESA = {
    **PESSOAL,
    "profileType": "business",
    "spentForecast": None,
    "byCategory": [{"name": "Fornecedores", "total": 600}],
    "byCategoryComplete": False,
    "commitments": {"until": None, "toPay": 700, "overdue": None, "toReceive": 1200},
    "cardsDebt": None,
}


def consulta(**campos) -> FinancialIntent:
    return FinancialIntent(intent=IntentType.query_summary, **campos)


# ── Período ──────────────────────────────────────────────────────────────────
def test_sem_periodo_fica_para_a_api_usar_o_mes_corrente():
    assert resolve_period(consulta(), HOJE) is None


def test_so_o_inicio_vira_o_mes_inteiro():
    assert resolve_period(consulta(period_start="2026-10-01"), HOJE) == (
        date(2026, 10, 1),
        date(2026, 10, 31),
    )


def test_so_o_fim_vira_o_mes_inteiro_e_pontas_invertidas_sao_trocadas():
    assert resolve_period(consulta(period_end="2026-02-28"), HOJE) == (
        date(2026, 2, 1),
        date(2026, 2, 28),
    )
    assert resolve_period(
        consulta(period_start="2026-11-30", period_end="2026-11-01"), HOJE
    ) == (date(2026, 11, 1), date(2026, 11, 30))


def test_data_invalida_e_ignorada():
    assert resolve_period(consulta(period_start="ontem"), HOJE) is None


@pytest.mark.parametrize(
    ("inicio", "fim", "rotulo"),
    [
        ("2026-11-01", "2026-11-30", "em novembro"),
        ("2025-10-01", "2025-10-31", "em outubro de 2025"),
        ("2026-11-21", "2026-11-21", "hoje"),
        ("2026-11-20", "2026-11-20", "em 20/11"),
        ("2026-01-01", "2026-12-31", "em 2026"),
        ("2026-11-16", "2026-11-22", "de 16/11 a 22/11"),
    ],
)
def test_rotulo_do_periodo(inicio, fim, rotulo):
    assert period_label(inicio, fim, HOJE) == rotulo


# ── Resposta ─────────────────────────────────────────────────────────────────
def test_gastos_com_as_maiores_categorias_e_os_previstos():
    resposta = format_summary(PESSOAL, consulta(summary_focus=SummaryFocusEnum.spending), HOJE)

    assert resposta.startswith("💸 *Gastos em novembro:* R$ 820,50")
    assert "Maiores: Mercado R$ 500,00 · Transporte R$ 300,00 · Lazer R$ 15,50" in resposta
    assert "Pets" not in resposta
    assert "Previstos, ainda não pagos: R$ 120,00" in resposta
    assert resposta.endswith(f"Detalhes no app: {settings.web_url}/app/pessoal/dashboard")


def test_gasto_de_uma_categoria_com_a_parte_do_total():
    resposta = format_summary(
        PESSOAL,
        consulta(summary_focus=SummaryFocusEnum.spending, category_name="mercado"),
        HOJE,
    )
    assert resposta.startswith(
        "💸 Gastos com *Mercado* em novembro: R$ 500,00 (61% do total de R$ 820,50)"
    )


def test_categoria_sem_gasto_na_lista_completa():
    resposta = format_summary(
        PESSOAL, consulta(summary_focus=SummaryFocusEnum.spending, category_name="Saúde"), HOJE
    )
    assert resposta.startswith("💸 Não encontrei gastos com *Saúde* em novembro.")


def test_categoria_fora_da_lista_parcial_nao_vira_zero():
    # O dashboard empresarial só traz as cinco maiores: fora delas pode haver gasto.
    resposta = format_summary(
        EMPRESA, consulta(summary_focus=SummaryFocusEnum.spending, category_name="Aluguel"), HOJE
    )
    assert "não está entre as maiores despesas em novembro" in resposta
    assert "Não encontrei" not in resposta


def test_categoria_sem_foco_conta_como_consulta_de_gastos():
    resposta = format_summary(PESSOAL, consulta(category_name="Transporte"), HOJE)
    assert resposta.startswith("💸 Gastos com *Transporte*")


def test_recebido_pessoa_fisica_e_receitas_pessoa_juridica():
    pessoal = format_summary(
        PESSOAL, consulta(transaction_type=TransactionTypeEnum.income), HOJE
    )
    assert pessoal.startswith("💰 *Recebido em novembro:* R$ 3.000,00")
    assert "Ainda a receber em novembro: R$ 200,00" in pessoal

    empresa = format_summary(EMPRESA, consulta(summary_focus=SummaryFocusEnum.income), HOJE)
    assert empresa.startswith("💰 *Receitas em novembro:* R$ 3.000,00")
    assert "A receber (em aberto): R$ 200,00" in empresa
    assert empresa.endswith("/app/empresa/dashboard")


def test_saldo_com_compromissos_ate_o_fim_do_mes_e_cartoes():
    resposta = format_summary(PESSOAL, consulta(summary_focus=SummaryFocusEnum.balance), HOJE)

    assert "🏦 *Saldo nas contas hoje:* R$ 1.500,00" in resposta
    assert (
        "Até 30/11: a pagar R$ 900,25 (R$ 110,00 já vencidos) · a receber R$ 200,00" in resposta
    )
    assert "Dívida nos cartões: R$ 980,00" in resposta


def test_saldo_pessoa_juridica_mostra_o_que_esta_em_aberto():
    resposta = format_summary(EMPRESA, consulta(summary_focus=SummaryFocusEnum.balance), HOJE)
    assert "Em aberto: a pagar R$ 700,00 · a receber R$ 1.200,00" in resposta
    assert "cartões" not in resposta


def test_saldo_sem_conta_cadastrada():
    resposta = format_summary(
        {**PESSOAL, "cashBalance": None}, consulta(summary_focus=SummaryFocusEnum.balance), HOJE
    )
    assert "ainda não tem conta cadastrada" in resposta


def test_contas_a_pagar_vencidas_primeiro_e_numeradas():
    resposta = format_summary(PESSOAL, consulta(summary_focus=SummaryFocusEnum.upcoming), HOJE)

    linhas = resposta.splitlines()
    assert linhas[0] == "📅 *Próximas contas a pagar:*"
    assert linhas[1] == "1. Luz — R$ 110,00 — ⚠️ venceu 10/11"
    assert linhas[2] == "2. Fatura Nubank — R$ 450,25 — vence 25/11"
    assert linhas[3] == "Total até 30/11: R$ 900,25"


def test_sem_contas_a_pagar():
    resposta = format_summary(
        {**PESSOAL, "upcoming": []}, consulta(summary_focus=SummaryFocusEnum.upcoming), HOJE
    )
    assert resposta.startswith("📅 Você não tem contas a pagar em aberto.")


def test_resumo_geral():
    resposta = format_summary(PESSOAL, consulta(), HOJE)

    assert resposta.startswith("📊 *Resumo em novembro*")
    assert "Gastos: R$ 820,50" in resposta
    assert "Recebido: R$ 3.000,00" in resposta
    assert "Sobrou: R$ 2.179,50" in resposta
    assert "Saldo nas contas hoje: R$ 1.500,00" in resposta
    assert "1. Luz — R$ 110,00 — ⚠️ venceu 10/11" in resposta


def test_resultado_negativo_em_palavras_de_leigo():
    resposta = format_summary({**PESSOAL, "result": -320.4}, consulta(), HOJE)
    assert "Gastou mais do que recebeu: R$ 320,40" in resposta


# ── Busca ────────────────────────────────────────────────────────────────────
class _Resposta:
    def __init__(self, status: int, body: dict) -> None:
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class _Api:
    def __init__(self, resposta: _Resposta | Exception) -> None:
        self.resposta = resposta
        self.chamadas: list[tuple[str, dict]] = []

    async def get(self, path, params=None):
        self.chamadas.append((path, params))
        if isinstance(self.resposta, Exception):
            raise self.resposta
        return self.resposta


async def test_busca_o_periodo_pedido_e_responde(monkeypatch):
    api = _Api(_Resposta(200, PESSOAL))
    monkeypatch.setattr(module, "api_client", api)

    resposta = await summary_service.answer(
        "u1", consulta(period_start="2026-11-01", period_end="2026-11-30"), HOJE
    )

    assert api.chamadas == [
        ("/internal/users/u1/summary", {"periodStart": "2026-11-01", "periodEnd": "2026-11-30"})
    ]
    assert resposta.startswith("📊 *Resumo em novembro*")


async def test_flag_desligada_manda_para_o_app(monkeypatch):
    monkeypatch.setattr(
        module, "api_client", _Api(_Resposta(403, {"code": "FEATURE_DISABLED"}))
    )
    assert await summary_service.answer("u1", consulta(), HOJE) == SUMMARY_UNAVAILABLE_MESSAGE


@pytest.mark.parametrize(
    "falha",
    [_Resposta(500, {}), _Resposta(403, {"code": "SUBSCRIPTION_REQUIRED"}), ConnectionError()],
)
async def test_falha_da_api_vira_mensagem_e_nao_excecao(monkeypatch, falha):
    monkeypatch.setattr(module, "api_client", _Api(falha))
    assert await summary_service.answer("u1", consulta(), HOJE) == SUMMARY_ERROR_MESSAGE


def test_mes_corrente_ate_hoje_vira_o_mes_inteiro():
    # O LLM real devolve "esse mês" como do dia 1 até hoje; a resposta diria
    # "de 01/11 a 21/11" em vez de "em novembro".
    assert resolve_period(consulta(period_start="2026-11-01", period_end="2026-11-21"), HOJE) == (
        date(2026, 11, 1),
        date(2026, 11, 30),
    )
    # Um recorte que termina antes de hoje é pedido de verdade e fica.
    assert resolve_period(consulta(period_start="2026-11-01", period_end="2026-11-15"), HOJE) == (
        date(2026, 11, 1),
        date(2026, 11, 15),
    )


# ── Receitas previstas ───────────────────────────────────────────────────────
COM_RECEITAS = {
    **PESSOAL,
    "upcomingIncome": [
        {
            "description": "pagamento Kazap",
            "remaining": 6825,
            "dueDate": "2026-12-01",
            "isOverdue": False,
        },
        {"description": "Freela", "remaining": 300, "dueDate": "2026-11-15", "isOverdue": True},
    ],
}


def test_resumo_mostra_receitas_previstas_separadas_das_contas():
    # Produção: o salário fixo aparecia em "Próximas contas" com vencimento.
    resposta = format_summary(COM_RECEITAS, consulta(), HOJE)

    contas, receitas = resposta.split("Receitas previstas:")
    assert "pagamento Kazap" not in contas
    linhas = receitas.strip().splitlines()
    assert linhas[0] == "1. Freela — R$ 300,00 — ⚠️ atrasada, era para 15/11"
    assert linhas[1] == "2. pagamento Kazap — R$ 6.825,00 — previsto para 01/12"


def test_pergunta_sobre_recebimentos_lista_as_receitas_previstas():
    resposta = format_summary(
        COM_RECEITAS, consulta(summary_focus=SummaryFocusEnum.income), HOJE
    )
    assert "Receitas previstas:" in resposta
    assert "pagamento Kazap — R$ 6.825,00 — previsto para 01/12" in resposta


def test_contas_a_pagar_nao_mostram_receitas():
    resposta = format_summary(
        COM_RECEITAS, consulta(summary_focus=SummaryFocusEnum.upcoming), HOJE
    )
    assert "pagamento Kazap" not in resposta
    assert "Receitas previstas" not in resposta


def test_api_antiga_sem_receitas_previstas_nao_quebra():
    resposta = format_summary(PESSOAL, consulta(), HOJE)
    assert "Receitas previstas" not in resposta
