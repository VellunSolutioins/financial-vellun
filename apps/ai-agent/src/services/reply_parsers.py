"""Leitura determinística de trechos de mensagem: valor, data, parcelas, etc.

Servem a dois usos:

- **Resposta a uma pergunta pendente.** Quem perguntou sabe qual campo espera
  ("Em quantas parcelas?"), e a resposta costuma ser curta ("10", "dia 5",
  "Nubank"). Um parser por campo lê só aquilo, sem LLM e sem sobrescrever o que
  a resposta não trouxe.
- **Fallback por regras** do ``intent_classifier``, quando o LLM falha.

Todas as funções são puras: recebem texto (e a data de referência, quando
precisam de "hoje") e devolvem o valor, ou ``None`` quando não entendem.
"""

from __future__ import annotations

import calendar
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, timedelta

from ..schemas.financial_intent import (
    AmountBasisEnum,
    RecurrenceFrequencyEnum,
    RecurrenceTypeEnum,
    TransactionTypeEnum,
)


def normalize(text: str) -> str:
    """Minúsculas, sem acento e sem espaço nas pontas."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower().strip()


def tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", normalize(text))


# ── Sim / não ────────────────────────────────────────────────────────────────
# Palavras inteiras: por substring, "simples" confirmava e "deixa eu ver" cancelava.
_AFFIRMATIVE = {
    "sim", "isso", "confirmo", "confirma", "confirmado", "ok", "pode", "correto", "certo",
    "exato", "beleza", "blz", "yes",
}
_NEGATIVE = {"nao", "cancela", "cancelar", "cancele", "errado", "desisto", "esquece"}
_NEGATIVE_PHRASES = ("deixa pra la", "deixa para la")


def is_affirmative(text: str) -> bool:
    words = tokens(text)
    return words == ["s"] or any(word in _AFFIRMATIVE for word in words)


def is_negative(text: str) -> bool:
    normalized = normalize(text)
    words = tokens(text)
    if words in (["n"], ["deixa"]) or any(p in normalized for p in _NEGATIVE_PHRASES):
        return True
    return any(word in _NEGATIVE for word in words)


# ── Valor ────────────────────────────────────────────────────────────────────
# Captura valores como "100", "5000", "47,50", "1.250,00", "R$ 30".
# A primeira alternativa exige separador de milhar; a segunda cobre inteiros
# simples e decimais com vírgula/ponto.
_AMOUNT_RE = re.compile(r"(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)")

# Números que não são o valor: datas, parcelas e repetições. Removidos antes de
# procurar o valor — em "10x de 300" o valor é 300, não 10.
_NOT_AMOUNT_RE = re.compile(
    r"\d{1,2}/\d{1,2}(?:/\d{2,4})?"  # 17/06, 17/06/2026
    r"|\d{4}-\d{2}-\d{2}"  # 2026-06-17
    r"|\b\d+\s*x\b"  # 10x
    r"|\bem\s+\d+\s+(?:vezes|parcelas|meses)\b"  # em 10 vezes
    r"|\b\d+\s+(?:vezes|parcelas|meses|anos?)\b"  # 12 vezes, 12 meses
    r"|\bdia\s+\d{1,2}\b",  # dia 10
    re.IGNORECASE,
)


def parse_amount(text: str) -> float | None:
    match = _AMOUNT_RE.search(_NOT_AMOUNT_RE.sub(" ", text.lower()))
    if not match:
        return None
    raw = match.group(1)
    if "," in raw:
        # Vírgula é decimal; pontos são separadores de milhar.
        raw = raw.replace(".", "").replace(",", ".")
    elif raw.count(".") == 1 and len(raw.split(".")[1]) == 3:
        # Ex.: "1.250" -> separador de milhar, não decimal.
        raw = raw.replace(".", "")
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value > 0 else None


# ── Tipo ─────────────────────────────────────────────────────────────────────
_INCOME_WORDS = {"receita", "entrada", "recebi", "recebimento", "ganho", "ganhei", "venda"}
_EXPENSE_WORDS = {"despesa", "gasto", "gastei", "saida", "paguei", "pagamento", "compra", "comprei"}


def parse_type(text: str) -> TransactionTypeEnum | None:
    words = set(tokens(text))
    if words & _INCOME_WORDS:
        return TransactionTypeEnum.income
    if words & _EXPENSE_WORDS:
        return TransactionTypeEnum.expense
    return None


# ── Data ─────────────────────────────────────────────────────────────────────
_WEEKDAYS = {
    "segunda": 0, "terca": 1, "quarta": 2, "quinta": 3, "sexta": 4, "sabado": 5, "domingo": 6,
}
_DMY_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2}|\d{4}))?\b")
_ISO_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_DAY_RE = re.compile(r"\bdia\s+(\d{1,2})\b")


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _previous_month_day(today: date, day: int) -> date | None:
    year, month = (today.year, today.month - 1) if today.month > 1 else (today.year - 1, 12)
    last = calendar.monthrange(year, month)[1]
    return _safe_date(year, month, min(day, last))


def parse_date(text: str, today: date) -> date | None:
    """Data explícita ou relativa a ``today`` (o dia em que a mensagem chegou).

    Entende: hoje, ontem, anteontem; dd/mm e dd/mm/aaaa; aaaa-mm-dd; "dia N"
    (no mês corrente, ou no anterior se ainda não chegou); dia da semana ("sexta",
    "sexta passada": a última que já passou).
    """
    normalized = normalize(text)
    words = set(tokens(text))

    if "anteontem" in words:
        return today - timedelta(days=2)
    if "ontem" in words:
        return today - timedelta(days=1)
    if "hoje" in words:
        return today

    if match := _ISO_RE.search(normalized):
        return _safe_date(int(match[1]), int(match[2]), int(match[3]))

    if match := _DMY_RE.search(normalized):
        day, month = int(match[1]), int(match[2])
        year = today.year
        if match[3]:
            year = int(match[3]) + (2000 if len(match[3]) == 2 else 0)
        return _safe_date(year, month, day)

    if match := _DAY_RE.search(normalized):
        day = int(match[1])
        if not 1 <= day <= 31:
            return None
        if day <= today.day:
            return _safe_date(today.year, today.month, day)
        return _previous_month_day(today, day)

    for name, weekday in _WEEKDAYS.items():
        if name in words:
            delta = (today.weekday() - weekday) % 7 or 7
            return today - timedelta(days=delta)

    return None


# ── Números ──────────────────────────────────────────────────────────────────
_NUMBER_WORDS = {
    "um": 1, "uma": 1, "dois": 2, "duas": 2, "tres": 3, "quatro": 4, "cinco": 5, "seis": 6,
    "sete": 7, "oito": 8, "nove": 9, "dez": 10, "onze": 11, "doze": 12, "treze": 13,
    "quatorze": 14, "catorze": 14, "quinze": 15, "dezesseis": 16, "dezessete": 17,
    "dezoito": 18, "dezenove": 19, "vinte": 20, "trinta": 30,
}


def parse_int(text: str) -> int | None:
    """Primeiro inteiro da resposta: "10", "10x", "em 10 vezes", "dez"."""
    if match := re.search(r"\d+", text):
        return int(match[0])
    for word in tokens(text):
        if word in _NUMBER_WORDS:
            return _NUMBER_WORDS[word]
    return None


# ── Recorrência ──────────────────────────────────────────────────────────────
_FREQUENCY_WORDS = {
    RecurrenceFrequencyEnum.monthly: (
        "mensal", "mensalmente", "todo mes", "por mes", "mensalidade",
    ),
    RecurrenceFrequencyEnum.bimonthly: ("bimestral", "a cada dois meses", "a cada 2 meses"),
    RecurrenceFrequencyEnum.semiannual: ("semestral", "a cada seis meses", "a cada 6 meses"),
    RecurrenceFrequencyEnum.annual: ("anual", "anualmente", "todo ano", "por ano"),
}
_UNSUPPORTED_FREQUENCY = ("semanal", "toda semana", "quinzenal", "diario", "todo dia", "trimestral")

#: Meses entre ocorrências, igual à API (``FREQUENCY_STEP_MONTHS``).
FREQUENCY_STEP_MONTHS = {
    RecurrenceFrequencyEnum.monthly: 1,
    RecurrenceFrequencyEnum.bimonthly: 2,
    RecurrenceFrequencyEnum.semiannual: 6,
    RecurrenceFrequencyEnum.annual: 12,
}


def parse_frequency(text: str) -> RecurrenceFrequencyEnum | None:
    normalized = normalize(text)
    for frequency, words in _FREQUENCY_WORDS.items():
        if any(word in normalized for word in words):
            return frequency
    return None


def mentions_unsupported_frequency(text: str) -> bool:
    normalized = normalize(text)
    return any(word in normalized for word in _UNSUPPORTED_FREQUENCY)


def parse_occurrences(text: str, frequency: RecurrenceFrequencyEnum | None) -> int | None:
    """Quantas vezes o fixo repete: "12", "12 vezes", "12 meses", "2 anos".

    Prazo em meses ou anos vira ocorrências pela frequência: 1 ano no mensal são
    12; no semestral, 2.
    """
    count = parse_int(text)
    if count is None:
        words = set(tokens(text))
        count = 1 if words & {"ano", "anos"} else None
    if count is None:
        return None
    words = set(tokens(text))
    step = FREQUENCY_STEP_MONTHS.get(frequency or RecurrenceFrequencyEnum.monthly, 1)
    if words & {"ano", "anos"}:
        return (count * 12) // step
    if words & {"mes", "meses"} and step > 1:
        return count // step
    return count


def parse_amount_basis(text: str) -> AmountBasisEnum | None:
    words = set(tokens(text))
    if words & {"total", "tudo", "inteiro", "cheio"}:
        return AmountBasisEnum.total
    if words & {"parcela", "cada", "mensal", "prestacao"}:
        return AmountBasisEnum.installment
    return None


@dataclass
class RecurrenceHint:
    """O que uma mensagem diz sobre recorrência (para o fallback por regras)."""

    recurrence_type: RecurrenceTypeEnum = RecurrenceTypeEnum.avulso
    installments: int | None = None
    amount_basis: AmountBasisEnum | None = None
    frequency: RecurrenceFrequencyEnum | None = None
    occurrences: int | None = None
    #: A frase traz os dois formatos ("3000 em 10x de 300"): o valor pode ser
    #: qualquer um. Diferente de ``amount_basis`` nulo por falta de sinal.
    basis_ambiguous: bool = False


_INSTALLMENTS_RE = re.compile(r"\b(\d+)\s*x\b|\bem\s+(\d+)\s+(?:vezes|parcelas)\b")
# "10x de 300", "parcelas de 300", "300 cada", "300 por parcela", "300 a parcela".
_INSTALLMENT_VALUE_RE = re.compile(
    r"\b\d+\s*x\s+de\b|\bparcelas?\s+de\b|\d\s*(?:reais\s+)?(?:cada|por\s+parcela|a\s+parcela)\b"
)
# Um valor seguido de "em Nx" / "parcelado em N": "3000 em 10x", "3000 reais parcelado em 10".
_TOTAL_VALUE_RE = re.compile(
    r"\d(?:[\d.,]*\d)?\s*(?:reais\s+)?(?:parcelad[oa]\s+)?em\s+\d+\s*(?:x|vezes|parcelas)?\b"
)
_PARCEL_WORD_RE = re.compile(r"\bparcel\w*|\bprestac\w*")
_FIXED_WORDS = ("todo mes", "todo ano", "mensal", "mensalidade", "assinatura", "recorrente",
                "fixo", "fixa", "anual", "bimestral", "semestral", "toda semana", "semanal")
_OCCURRENCES_RE = re.compile(r"\bpor\s+(\d+)\s+(meses|anos?|vezes)\b")


def detect_recurrence(text: str) -> RecurrenceHint:
    normalized = normalize(text)
    installments_match = _INSTALLMENTS_RE.search(normalized)
    count = None
    if installments_match:
        count = int(installments_match[1] or installments_match[2])

    if (count is not None and count > 1) or _PARCEL_WORD_RE.search(normalized):
        # "10x de 300" é o valor da parcela; "3000 em 10x", o total. Com os dois
        # na mesma frase, não dá para saber qual número é o valor: pergunta.
        per_installment = bool(_INSTALLMENT_VALUE_RE.search(normalized))
        total = bool(_TOTAL_VALUE_RE.search(normalized))
        basis = None
        if per_installment and not total:
            basis = AmountBasisEnum.installment
        elif total and not per_installment:
            basis = AmountBasisEnum.total
        return RecurrenceHint(
            recurrence_type=RecurrenceTypeEnum.parcelado,
            installments=count if count and count > 1 else None,
            amount_basis=basis,
            basis_ambiguous=per_installment and total,
        )

    if any(word in normalized for word in _FIXED_WORDS):
        frequency = parse_frequency(normalized)
        occurrences = None
        if match := _OCCURRENCES_RE.search(normalized):
            occurrences = parse_occurrences(match[0], frequency)
        return RecurrenceHint(
            recurrence_type=RecurrenceTypeEnum.fixo, frequency=frequency, occurrences=occurrences
        )

    return RecurrenceHint()


# ── Nomes (contas, cartões, categorias) ──────────────────────────────────────
def match_names(reply: str, names: list[str]) -> list[int]:
    """Índices dos nomes que casam com a resposta: exatos; sem exato, parciais.

    Sem acento e sem caixa. Parcial nos dois sentidos ("itau" casa "Itaú
    Platinum"; "cartao nubank" casa "Nubank"), com mínimo de 3 letras para não
    casar tudo com "a".
    """
    target = normalize(reply)
    if not target:
        return []
    normalized = [normalize(name) for name in names]
    exact = [i for i, name in enumerate(normalized) if name == target]
    if exact:
        return exact
    if len(target) < 3:
        return []
    return [
        i
        for i, name in enumerate(normalized)
        if len(name) >= 3 and (target in name or name in target)
    ]
