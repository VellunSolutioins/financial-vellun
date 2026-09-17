"""Regras de confirmação do §9.4.

Decide se um ``FinancialIntent`` pode virar lançamento direto ou se exige
confirmação do usuário antes.
"""

import re

from ..config import settings
from ..schemas.financial_intent import FinancialIntent

# Limiar de coerência de valor: acima disso sem contexto, pedir confirmação.
MAX_REASONABLE_AMOUNT = 100_000.0

_INSTALLMENT_RE = re.compile(
    r"\b(\d+\s*x|parcel|presta(ç|c)(õ|o)es|em\s+\d+\s+vezes)\b", re.IGNORECASE
)
_AMBIGUOUS_DATE_RE = re.compile(
    r"\b(semana passada|m(ê|e)s passado|outro dia|esses dias|recentemente)\b",
    re.IGNORECASE,
)


def needs_confirmation(
    intent: FinancialIntent, raw_message: str = ""
) -> tuple[bool, str]:
    """Retorna ``(precisa_confirmar, pergunta)``."""
    threshold = settings.confidence_threshold

    # Zero conta como ausente: sem valor na mensagem, o LLM costuma preencher
    # `amount: 0` em vez de nulo. Antes o zero passava, a API recusava o
    # lançamento e o usuário recebia um erro genérico em vez desta pergunta.
    if intent.amount is None or intent.amount <= 0:
        return True, "Não identifiquei o valor. Qual foi o valor do lançamento?"

    if intent.transaction_type is None:
        return True, "Esse lançamento é uma receita ou uma despesa?"

    if _INSTALLMENT_RE.search(raw_message):
        return True, (
            "Parece um parcelamento. Quer registrar o valor total ou apenas "
            "a parcela deste mês?"
        )

    if _AMBIGUOUS_DATE_RE.search(raw_message):
        return True, "Em qual data exatamente foi esse lançamento? (ex.: 17/06/2026)"

    if intent.amount > MAX_REASONABLE_AMOUNT:
        return True, (
            f"O valor de R$ {intent.amount:,.2f} é alto. Confirma que está correto?"
        )

    if intent.category_name is None:
        return True, "Em qual categoria devo registrar esse lançamento?"

    if intent.confidence < threshold:
        return True, (
            "Não tenho certeza se entendi corretamente. Você confirma o "
            "lançamento?"
        )

    return False, ""
