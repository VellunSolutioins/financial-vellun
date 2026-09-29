"""Regras de confirmação do §9.4.

Decide se um ``FinancialIntent`` pode virar lançamento direto ou se exige uma
pergunta antes. Cada pergunta diz **qual campo** a resposta deve preencher: é o
que permite ler "10" como número de parcelas, e não como valor.

Conta, cartão e categoria dependem do catálogo do usuário e são conferidos
depois, em ``transaction_creator.pending_question``.
"""

import re
from dataclasses import dataclass
from datetime import date

from ..config import settings
from ..schemas.financial_intent import (
    AmountBasisEnum,
    FinancialIntent,
    RecurrenceTypeEnum,
)

# Limiar de coerência de valor: acima disso sem contexto, pedir confirmação.
MAX_REASONABLE_AMOUNT = 100_000.0

#: Faixas aceitas pela API (``CreateTransactionDto``).
MIN_INSTALLMENTS, MAX_INSTALLMENTS = 2, 72
MIN_OCCURRENCES, MAX_OCCURRENCES = 2, 120

# Campos que uma pergunta pode esperar como resposta.
FIELD_AMOUNT = "amount"
FIELD_TYPE = "type"
FIELD_DATE = "date"
FIELD_ACCOUNT = "account"
FIELD_CATEGORY = "category"
FIELD_INSTALLMENTS = "installments"
FIELD_AMOUNT_BASIS = "amount_basis"
FIELD_FREQUENCY = "frequency"
FIELD_OCCURRENCES = "occurrences"
#: Sim ou não sobre o lançamento inteiro (valor alto, baixa confiança, comprovante).
FIELD_CONFIRM = "confirm"

_AMBIGUOUS_DATE_RE = re.compile(
    r"\b(semana passada|m(ê|e)s passado|outro dia|esses dias|recentemente)\b",
    re.IGNORECASE,
)

QUESTION_AMOUNT = "Não identifiquei o valor. Qual foi o valor do lançamento?"
QUESTION_DATE = "Em qual data exatamente foi esse lançamento? (ex.: 17/06/2026)"
QUESTION_INSTALLMENTS = "Em quantas parcelas foi? (de 2 a 72)"
QUESTION_FREQUENCY = (
    "Com que frequência esse lançamento se repete? Mensal, bimestral, semestral ou anual?"
)
QUESTION_OCCURRENCES = "Quantas vezes ele deve se repetir? (de 2 a 120)"


@dataclass(frozen=True)
class Question:
    """Pergunta ao usuário e o campo que a resposta preenche."""

    field: str
    text: str


def format_brl(value: float) -> str:
    return f"R$ {value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _valid_iso_date(value: str) -> bool:
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def next_question(
    intent: FinancialIntent, raw_message: str = "", *, confirmed_total: float | None = None
) -> Question | None:
    """A próxima pergunta a fazer, ou ``None`` se nada disto falta.

    ``raw_message`` é o texto recebido agora (a mensagem ou a resposta), usado
    só para detectar datas vagas. ``confirmed_total`` é o total que o usuário
    já confirmou: a pergunta de valor alto não se repete para ele.
    """
    # Zero conta como ausente: sem valor na mensagem, o LLM costuma preencher
    # `amount: 0` em vez de nulo. Antes o zero passava, a API recusava o
    # lançamento e o usuário recebia um erro genérico em vez desta pergunta.
    if intent.amount is None or intent.amount <= 0:
        return Question(FIELD_AMOUNT, QUESTION_AMOUNT)

    if intent.transaction_type is None:
        return Question(FIELD_TYPE, "Esse lançamento é uma receita ou uma despesa?")

    if intent.transaction_date is not None and not _valid_iso_date(intent.transaction_date):
        return Question(FIELD_DATE, QUESTION_DATE)

    if _AMBIGUOUS_DATE_RE.search(raw_message):
        return Question(FIELD_DATE, QUESTION_DATE)

    recurrence = _recurrence_question(intent)
    if recurrence is not None:
        return recurrence

    # No parcelado vale o total da compra, que é o que a API grava: "3000 por
    # parcela, 60 vezes" são R$ 180 mil, e antes passava sem pergunta.
    total = total_amount(intent)
    already_confirmed = confirmed_total is not None and abs(confirmed_total - total) < 0.005
    if total > MAX_REASONABLE_AMOUNT and not already_confirmed:
        if total != intent.amount:
            what = (
                f"O valor total de {format_brl(total)} "
                f"({intent.installments}x de {format_brl(intent.amount)})"
            )
        else:
            what = f"O valor de {format_brl(total)}"
        return Question(FIELD_CONFIRM, f"{what} é alto. Confirma que está correto?")

    if intent.confidence < settings.confidence_threshold:
        return Question(
            FIELD_CONFIRM,
            "Não tenho certeza se entendi corretamente. Você confirma o lançamento?",
        )

    return None


def _recurrence_question(intent: FinancialIntent) -> Question | None:
    """Parcelado precisa do número de parcelas e de saber se o valor é o total;
    fixo precisa da frequência e de quantas vezes repete."""
    if intent.recurrence_type == RecurrenceTypeEnum.parcelado:
        if intent.installments is None:
            return Question(FIELD_INSTALLMENTS, QUESTION_INSTALLMENTS)
        if not MIN_INSTALLMENTS <= intent.installments <= MAX_INSTALLMENTS:
            return Question(
                FIELD_INSTALLMENTS,
                "O parcelamento aceita de 2 a 72 parcelas. Em quantas parcelas foi?",
            )
        if intent.amount_basis is None:
            return Question(
                FIELD_AMOUNT_BASIS,
                f"{format_brl(intent.amount or 0)} é o valor total da compra "
                "ou o valor de cada parcela?",
            )

    if intent.recurrence_type == RecurrenceTypeEnum.fixo:
        if intent.recurrence_frequency is None:
            return Question(FIELD_FREQUENCY, QUESTION_FREQUENCY)
        if intent.occurrences is None:
            return Question(FIELD_OCCURRENCES, QUESTION_OCCURRENCES)
        if not MIN_OCCURRENCES <= intent.occurrences <= MAX_OCCURRENCES:
            return Question(
                FIELD_OCCURRENCES,
                "O lançamento fixo aceita de 2 a 120 repetições. "
                "Quantas vezes ele deve se repetir?",
            )

    return None


def total_amount(intent: FinancialIntent) -> float:
    """Valor a enviar à API: no parcelado, sempre o total da compra."""
    amount = intent.amount or 0
    if (
        intent.recurrence_type == RecurrenceTypeEnum.parcelado
        and intent.amount_basis == AmountBasisEnum.installment
        and intent.installments
    ):
        return round(amount * intent.installments, 2)
    return amount


def needs_confirmation(intent: FinancialIntent, raw_message: str = "") -> tuple[bool, str]:
    """Retorna ``(precisa_confirmar, pergunta)``. Ver :func:`next_question`."""
    question = next_question(intent, raw_message)
    return (True, question.text) if question else (False, "")
