"""Testes do interpretador baseado em regras (P3.3).

Forçam o modo apenas-regras com ``IntentClassifier(provider=None)`` para
serem determinísticos e independentes de `OPENAI_API_KEY`.
"""

import asyncio
from datetime import timedelta

from src.schemas.financial_intent import (
    AmountBasisEnum,
    IntentType,
    RecurrenceFrequencyEnum,
    RecurrenceTypeEnum,
    SummaryFocusEnum,
    TransactionTypeEnum,
)
from src.services.clock import today_local
from src.services.intent_classifier import IntentClassifier

classifier = IntentClassifier(provider=None)


def classify(message: str, context: dict | None = None):
    return asyncio.run(classifier.classify(message, context or {}))


def test_expense_with_category():
    result = classify("gastei 100 no mercado")
    assert result.intent == IntentType.create_transaction
    assert result.transaction_type == TransactionTypeEnum.expense
    assert result.amount == 100
    assert result.category_name == "Mercado"
    assert result.confidence >= 0.8
    assert result.needs_confirmation is False


def test_expense_with_purchase_noun():
    result = classify("compra de 25 reais de gasolina")
    assert result.intent == IntentType.create_transaction
    assert result.transaction_type == TransactionTypeEnum.expense
    assert result.amount == 25
    assert result.category_name == "Transporte"
    assert result.needs_confirmation is False


def test_income_salary():
    result = classify("recebi 5000 de salário")
    assert result.transaction_type == TransactionTypeEnum.income
    assert result.amount == 5000
    assert result.category_name == "Salário"


def test_income_with_sale_noun():
    result = classify("venda de 85 reais")
    assert result.intent == IntentType.create_transaction
    assert result.transaction_type == TransactionTypeEnum.income
    assert result.amount == 85
    assert result.category_name == "Vendas"


def test_expense_without_category_needs_confirmation():
    result = classify("paguei 300")
    assert result.needs_confirmation is True


def test_decimal_amount_and_relative_date():
    result = classify("gastei 47,50 no almoço ontem")
    assert result.amount == 47.5
    assert result.category_name == "Alimentação"
    expected = (today_local() - timedelta(days=1)).isoformat()
    assert result.transaction_date == expected


def test_help_intent():
    result = classify("preciso de ajuda")
    assert result.intent == IntentType.help


def test_query_summary_intent():
    result = classify("qual meu saldo?")
    assert result.intent == IntentType.query_summary


def test_sem_valor_nem_tipo_e_unknown():
    # Antes as regras nunca devolviam unknown: "oi" virava "Não identifiquei o valor…".
    assert classify("oi, tudo bem?").intent == IntentType.unknown


def test_parcelas_nao_sao_confundidas_com_o_valor():
    result = classify("comprei uma tv em 10x de 300")
    assert result.amount == 300
    assert result.recurrence_type == RecurrenceTypeEnum.parcelado
    assert result.installments == 10
    assert result.amount_basis == AmountBasisEnum.installment


def test_recorrente_pelas_regras():
    result = classify("paguei 55 da netflix todo mês")
    assert result.recurrence_type == RecurrenceTypeEnum.fixo
    assert result.recurrence_frequency == RecurrenceFrequencyEnum.monthly


def test_data_explicita_e_relativa_ao_dia_do_contexto():
    result = classify("gastei 50 no mercado dia 10", {"today": "2026-09-27"})
    assert result.transaction_date == "2026-09-10"


def test_categoria_do_dicionario_so_vale_se_existir_no_catalogo():
    catalogo = {"expense_categories": ["Casa", "Outros"], "income_categories": ["Salário"]}
    # "Aluguel" é categoria do perfil PJ; o usuário não a tem.
    assert classify("paguei 1500 de aluguel", catalogo).category_name is None
    # Nome do próprio catálogo citado na mensagem.
    assert classify("gastei 80 com a casa", catalogo).category_name == "Casa"


def test_categoria_de_receita_nao_e_sugerida_para_despesa():
    catalogo = {"expense_categories": ["Mercado"], "income_categories": ["Salário"]}
    assert classify("recebi 5000 de salário", catalogo).category_name == "Salário"
    # Despesa: "salário" aponta para uma categoria de receita, que não serve.
    assert classify("paguei 900 de salário da diarista", catalogo).category_name is None


# ── Modelo financeiro (docs/adrs/0018) ─────────────────────────────────────
# Movimentações que não são receita nem despesa. Pago ou a pagar é regra da
# API (docs/adrs/0020): o agente não opina.


def test_conta_que_vence_continua_sendo_lancamento():
    result = classify("conta de luz de 180 vence dia 10")
    assert result.intent == IntentType.create_transaction
    assert not hasattr(result, "settled")


def test_transferencia_entre_contas_proprias_nao_vira_despesa():
    result = classify("transferi 500 entre minhas contas")
    assert result.intent == IntentType.unsupported_movement
    assert result.transaction_type is None


def test_emprestimo_e_aporte_nao_viram_receita_nem_despesa():
    assert classify("recebi 10000 de empréstimo").intent == IntentType.unsupported_movement
    assert classify("aportei 2000 no CDB").intent == IntentType.unsupported_movement
    assert classify("resgatei 500 da aplicação").intent == IntentType.unsupported_movement


def test_juros_do_emprestimo_continuam_sendo_gasto():
    result = classify("paguei 150 de juros do empréstimo")
    assert result.intent == IntentType.create_transaction
    assert result.transaction_type == TransactionTypeEnum.expense


CONTEXTO_CONSULTA = {
    "today": "2026-11-21",
    "expense_categories": ["Mercado", "Transporte"],
    "income_categories": ["Salário"],
}


def test_quanto_gastei_e_consulta_e_nao_lancamento_sem_valor():
    # Antes "gastei" levava à criação, que perguntava o valor do lançamento.
    result = classify("quanto gastei esse mês?", CONTEXTO_CONSULTA)
    assert result.intent == IntentType.query_summary
    assert result.summary_focus == SummaryFocusEnum.spending


def test_consulta_de_categoria_com_periodo():
    result = classify("quanto gastei com mercado em outubro de 2025?", CONTEXTO_CONSULTA)
    assert result.intent == IntentType.query_summary
    assert result.category_name == "Mercado"
    assert (result.period_start, result.period_end) == ("2025-10-01", "2025-10-31")
    assert result.amount is None


def test_consulta_de_contas_a_pagar():
    result = classify("o que tenho pra pagar?", CONTEXTO_CONSULTA)
    assert result.intent == IntentType.query_summary
    assert result.summary_focus == SummaryFocusEnum.upcoming


def test_conta_a_pagar_com_valor_continua_sendo_lancamento():
    result = classify("conta a pagar de 100 de internet vence dia 30", CONTEXTO_CONSULTA)
    assert result.intent == IntentType.create_transaction
    assert result.amount == 100


def test_llm_que_toma_pergunta_por_lancamento_sem_valor_vira_consulta():
    from src.schemas.financial_intent import FinancialIntent

    class Llm:
        async def extract_intent(self, message, context):
            return FinancialIntent(
                intent=IntentType.create_transaction,
                transaction_type=TransactionTypeEnum.expense,
                category_name="Mercado",
            )

    result = asyncio.run(
        IntentClassifier(provider=Llm()).classify(
            "quanto gastei com mercado?", CONTEXTO_CONSULTA
        )
    )
    assert result.intent == IntentType.query_summary
    assert result.category_name == "Mercado"


def test_conta_a_pagar_sem_valor_e_sem_pergunta_nao_vira_consulta():
    # Sem "?" nem abertura de pergunta, "a pagar" descreve a conta, não pergunta.
    assert classify("conta de luz a pagar vence dia 20", CONTEXTO_CONSULTA).intent != (
        IntentType.query_summary
    )
    assert classify("o que tenho a pagar", CONTEXTO_CONSULTA).intent == IntentType.query_summary


def test_llm_sem_sinal_de_pergunta_continua_valendo():
    from src.schemas.financial_intent import FinancialIntent

    class Llm:
        async def extract_intent(self, message, context):
            return FinancialIntent(
                intent=IntentType.create_transaction,
                transaction_type=TransactionTypeEnum.expense,
                description="saldo do cartão",
            )

    result = asyncio.run(
        IntentClassifier(provider=Llm()).classify("paguei o saldo do cartão", CONTEXTO_CONSULTA)
    )
    assert result.intent == IntentType.create_transaction


class _LlmFixo:
    """LLM que devolve sempre o mesmo intent (o que ele errou em produção)."""

    def __init__(self, intent):
        self.intent = intent

    async def extract_intent(self, message, context):
        return self.intent.model_copy(deep=True)


def test_llm_que_toma_conta_com_valor_por_consulta_nao_impede_o_registro():
    # Produção: "conta de internet de 100 vence dia 20" virou "o que tenho pra
    # pagar?" e a conta não foi registrada.
    from src.schemas.financial_intent import FinancialIntent

    llm = _LlmFixo(
        FinancialIntent(intent=IntentType.query_summary, summary_focus=SummaryFocusEnum.upcoming)
    )
    classificador = IntentClassifier(provider=llm)
    for frase, valor in (
        ("conta de internet de 100 vence dia 20", 100),
        ("boleto de 300 vence sexta", 300),
        ("conta a pagar de 90 da academia", 90),
    ):
        result = asyncio.run(classificador.classify(frase, CONTEXTO_CONSULTA))
        assert result.intent == IntentType.create_transaction, frase
        assert result.amount == valor
        assert result.transaction_type == TransactionTypeEnum.expense


def test_consulta_do_llm_sem_valor_continua_consulta():
    from src.schemas.financial_intent import FinancialIntent

    llm = _LlmFixo(
        FinancialIntent(
            intent=IntentType.query_summary,
            summary_focus=SummaryFocusEnum.spending,
            period_start="2025-10-01",
            period_end="2025-10-31",
        )
    )
    result = asyncio.run(
        IntentClassifier(provider=llm).classify(
            "quanto gastei nos últimos 30 dias de outubro de 2025?", CONTEXTO_CONSULTA
        )
    )
    assert result.intent == IntentType.query_summary
    assert result.period_start == "2025-10-01"


def test_a_receber_com_valor_e_receita():
    result = classify("vou receber 800 do cliente, vence dia 10", CONTEXTO_CONSULTA)
    assert result.transaction_type == TransactionTypeEnum.income


# ── Falha do provedor ────────────────────────────────────────────────────────
class _ErroHttp(Exception):
    def __init__(self, status_code):
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code


class _LlmQueFalha:
    def __init__(self, erro):
        self.erro = erro

    async def extract_intent(self, message, context):
        raise self.erro


def test_chave_recusada_vira_erro_com_contador_proprio(caplog):
    from src.services.metrics import metrics

    antes = metrics.snapshot()["counters"].get("llm_auth_failed", 0)
    with caplog.at_level("WARNING"):
        result = asyncio.run(
            IntentClassifier(provider=_LlmQueFalha(_ErroHttp(401))).classify(
                "gastei 50 no mercado", CONTEXTO_CONSULTA
            )
        )

    # O fallback continua registrando...
    assert result.intent == IntentType.create_transaction
    # ...mas a chave inválida não passa mais despercebida.
    assert metrics.snapshot()["counters"]["llm_auth_failed"] == antes + 1
    registro = next(r for r in caplog.records if "credencial" in r.getMessage())
    assert registro.levelname == "ERROR"
    assert "_ErroHttp" in registro.getMessage()


def test_instabilidade_do_llm_fica_como_aviso_com_o_tipo_do_erro(caplog):
    from src.services.metrics import metrics

    antes = metrics.snapshot()["counters"].get("llm_auth_failed", 0)
    with caplog.at_level("WARNING"):
        asyncio.run(
            IntentClassifier(provider=_LlmQueFalha(TimeoutError())).classify(
                "gastei 50 no mercado", CONTEXTO_CONSULTA
            )
        )

    assert metrics.snapshot()["counters"].get("llm_auth_failed", 0) == antes
    registro = next(r for r in caplog.records if "LLM falhou" in r.getMessage())
    assert registro.levelname == "WARNING"
    assert "TimeoutError" in registro.getMessage()


# ── Baixa e fatura (Fase 2) ──────────────────────────────────────────────────
def test_pagar_fatura_nao_e_gasto():
    result = classify("paguei a fatura do nubank", CONTEXTO_CONSULTA)
    assert result.intent == IntentType.pay_invoice
    assert classify("paguei 500 da fatura", CONTEXTO_CONSULTA).amount == 500


def test_dar_baixa_pelas_regras():
    result = classify("marca a luz como paga", CONTEXTO_CONSULTA)
    assert result.intent == IntentType.settle_bill
    assert result.transaction_type == TransactionTypeEnum.expense

    recebido = classify("já recebi do cliente joão", CONTEXTO_CONSULTA)
    assert recebido.intent == IntentType.settle_bill
    assert recebido.transaction_type == TransactionTypeEnum.income


def test_gasto_comum_continua_lancamento():
    assert classify("paguei 120 de luz", CONTEXTO_CONSULTA).intent == (
        IntentType.create_transaction
    )


def test_llm_que_lanca_pagamento_de_fatura_como_gasto_e_corrigido():
    from src.schemas.financial_intent import FinancialIntent

    llm = _LlmFixo(
        FinancialIntent(
            intent=IntentType.create_transaction,
            transaction_type=TransactionTypeEnum.expense,
            amount=450,
        )
    )
    result = asyncio.run(
        IntentClassifier(provider=llm).classify("paguei 450 da fatura do nubank", CONTEXTO_CONSULTA)
    )
    assert result.intent == IntentType.pay_invoice
    assert result.amount == 450


def test_baixa_e_fatura_descartam_conta_e_cartao_nao_citados():
    from src.schemas.financial_intent import FinancialIntent

    llm = _LlmFixo(
        FinancialIntent(
            intent=IntentType.pay_invoice, card_name="Nubank", account_name="Itaú"
        )
    )
    result = asyncio.run(
        IntentClassifier(provider=llm).classify("paguei a fatura do cartão", CONTEXTO_CONSULTA)
    )
    # A conta de onde sai o dinheiro e o cartão precisam ter sido ditos.
    assert result.account_name is None
    assert result.card_name is None

    citado = asyncio.run(
        IntentClassifier(provider=llm).classify(
            "paguei a fatura do nubank pelo itaú", CONTEXTO_CONSULTA
        )
    )
    assert (citado.card_name, citado.account_name) == ("Nubank", "Itaú")


# ── Fase 3: corrigir e excluir ───────────────────────────────────────────────
def test_excluir_pelas_regras_aponta_o_lancamento():
    ultimo = classify("apaga o último", CONTEXTO_CONSULTA)
    assert ultimo.intent == IntentType.cancel_last
    assert ultimo.target.last is True

    citado = classify("exclui o mercado de 50 de ontem", CONTEXTO_CONSULTA)
    assert citado.intent == IntentType.cancel_last
    assert citado.target.last is False
    # "Ontem" é relativo ao dia da mensagem (21/11 no contexto).
    assert (citado.target.amount, citado.target.date) == (50, "2026-11-20")


def test_corrigir_pelas_regras_o_valor_e_o_que_muda():
    result = classify("errei, foi 45", CONTEXTO_CONSULTA)
    assert result.intent == IntentType.correct_last
    assert result.changes.amount == 45
    assert result.target.amount is None


def test_correcao_descarta_conta_nova_nao_citada():
    from src.schemas.financial_intent import EntryChanges, FinancialIntent, TargetRef

    llm = _LlmFixo(
        FinancialIntent(
            intent=IntentType.correct_last,
            target=TargetRef(last=True),
            changes=EntryChanges(amount=45, account_name="Itaú"),
        )
    )
    result = asyncio.run(
        IntentClassifier(provider=llm).classify("corrige o último, foi 45", CONTEXTO_CONSULTA)
    )
    assert result.changes.account_name is None
    assert result.changes.amount == 45


def _corrigir_pelo_llm(mensagem, target, changes):
    from src.schemas.financial_intent import EntryChanges, FinancialIntent, TargetRef

    llm = _LlmFixo(
        FinancialIntent(
            intent=IntentType.correct_last,
            target=TargetRef(**target),
            changes=EntryChanges(**changes),
        )
    )
    return asyncio.run(IntentClassifier(provider=llm).classify(mensagem, CONTEXTO_CONSULTA))


def test_correcao_sem_data_na_frase_nao_muda_a_data():
    # O LLM real preenchia a data de hoje: "errei, foi 45" mudaria a data.
    result = _corrigir_pelo_llm(
        "errei, foi 45",
        {"last": True, "date": "2026-11-21"},
        {"amount": 45, "transaction_date": "2026-11-21"},
    )
    assert result.target.date is None
    assert result.changes.transaction_date is None
    assert result.changes.amount == 45


def test_data_que_aponta_o_lancamento_vai_para_o_alvo():
    result = _corrigir_pelo_llm(
        "corrige o mercado de ontem, era 45",
        {"description": "mercado"},
        {"amount": 45, "transaction_date": "2026-11-20"},
    )
    assert result.target.date == "2026-11-20"
    assert result.changes.transaction_date is None


def test_foi_dia_20_e_a_data_nova():
    result = _corrigir_pelo_llm(
        "na verdade o mercado foi dia 20",
        {"description": "mercado", "date": "2026-11-20"},
        {},
    )
    assert result.target.date is None
    assert result.changes.transaction_date == "2026-11-20"
