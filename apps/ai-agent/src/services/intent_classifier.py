"""Interpretador de mensagens em linguagem natural.

Estratégia principal: LLM (quando configurado). Fallback: regras simples
(regex + dicionário de palavras-chave), garantindo que o fluxo continue
funcionando mesmo sem `OPENAI_API_KEY`.
"""

import logging
import re
from datetime import date, timedelta

from ..schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum
from .llm.base import LlmProvider
from .llm.factory import create_llm_provider

logger = logging.getLogger(__name__)

EXPENSE_KEYWORDS = (
    "gastei", "paguei", "comprei", "gasto", "despesa", "gastando", "pagamento",
)
INCOME_KEYWORDS = (
    "recebi", "ganhei", "recebimento", "entrou", "receita", "caiu", "vendi",
)
QUERY_KEYWORDS = ("resumo", "saldo", "quanto", "balanço", "balanco", "relatório", "relatorio")
HELP_KEYWORDS = ("ajuda", "help", "socorro", "como funciona", "o que voce faz", "o que você faz")
CANCEL_KEYWORDS = ("cancela", "cancelar", "apaga", "apagar", "desfaz", "desfazer", "remove")
CORRECT_KEYWORDS = ("corrige", "corrigir", "errei", "na verdade", "muda", "mudar", "ajusta")

# Palavra-chave -> nome de categoria padrão (do seed §7).
CATEGORY_KEYWORDS: dict[str, str] = {
    "mercado": "Mercado",
    "supermercado": "Mercado",
    "feira": "Mercado",
    "almoço": "Alimentação",
    "almoco": "Alimentação",
    "jantar": "Alimentação",
    "lanche": "Alimentação",
    "restaurante": "Alimentação",
    "comida": "Alimentação",
    "padaria": "Alimentação",
    "café": "Alimentação",
    "cafe": "Alimentação",
    "uber": "Transporte",
    "ônibus": "Transporte",
    "onibus": "Transporte",
    "gasolina": "Transporte",
    "combustível": "Transporte",
    "combustivel": "Transporte",
    "metrô": "Transporte",
    "metro": "Transporte",
    "táxi": "Transporte",
    "taxi": "Transporte",
    "transporte": "Transporte",
    "aluguel": "Aluguel",
    "condomínio": "Moradia",
    "condominio": "Moradia",
    "luz": "Moradia",
    "água": "Moradia",
    "agua": "Moradia",
    "internet": "Moradia",
    "médico": "Saúde",
    "medico": "Saúde",
    "farmácia": "Saúde",
    "farmacia": "Saúde",
    "remédio": "Saúde",
    "remedio": "Saúde",
    "dentista": "Saúde",
    "escola": "Educação",
    "curso": "Educação",
    "faculdade": "Educação",
    "livro": "Educação",
    "cinema": "Lazer",
    "viagem": "Lazer",
    "show": "Lazer",
    "bar": "Lazer",
    "salário": "Salário",
    "salario": "Salário",
    "investimento": "Investimentos",
    "dividendo": "Investimentos",
    "marketing": "Marketing",
    "software": "Software",
    "imposto": "Impostos",
    "fornecedor": "Fornecedores",
    "venda": "Vendas",
}

# Captura valores como "100", "5000", "47,50", "1.250,00", "R$ 30".
# A primeira alternativa exige separador de milhar; a segunda cobre inteiros
# simples e decimais com vírgula/ponto.
_AMOUNT_RE = re.compile(
    r"(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)"
)


_UNSET = object()


class IntentClassifier:
    def __init__(self, provider: LlmProvider | None | object = _UNSET) -> None:
        # `provider` ausente -> usa a factory; `provider=None` -> apenas regras;
        # uma instância -> injeção explícita (útil em testes).
        if provider is _UNSET:
            self._provider: LlmProvider | None = create_llm_provider()
        else:
            self._provider = provider  # type: ignore[assignment]

    async def classify(self, message: str, user_context: dict | None = None) -> FinancialIntent:
        context = user_context or {}

        if self._provider is not None:
            try:
                intent = await self._provider.extract_intent(message, context)
                return self._finalize(intent)
            except Exception:  # noqa: BLE001 — falha do LLM aciona o fallback
                logger.warning("LLM falhou; usando fallback de regras", exc_info=True)

        return self._classify_with_rules(message, context)

    def classify_with_rules(self, message: str, context: dict | None = None) -> FinancialIntent:
        """Classificação síncrona apenas por regras (útil para respostas de confirmação)."""
        return self._classify_with_rules(message, context or {})

    # ── Regras ────────────────────────────────────────────────────────────
    def _classify_with_rules(self, message: str, context: dict) -> FinancialIntent:
        text = message.lower().strip()

        if self._has_any(text, HELP_KEYWORDS):
            return FinancialIntent(intent=IntentType.help, confidence=0.9)
        if self._has_any(text, CANCEL_KEYWORDS):
            return FinancialIntent(intent=IntentType.cancel_last, confidence=0.85)
        if self._has_any(text, CORRECT_KEYWORDS):
            return FinancialIntent(intent=IntentType.correct_last, confidence=0.8)
        if self._has_any(text, QUERY_KEYWORDS) and not self._has_any(
            text, EXPENSE_KEYWORDS + INCOME_KEYWORDS
        ):
            return FinancialIntent(intent=IntentType.query_summary, confidence=0.85)

        transaction_type = self._detect_type(text)
        amount = self._extract_amount(text)
        category_name = self._detect_category(text)
        transaction_date = self._detect_date(text)

        intent = FinancialIntent(
            intent=IntentType.create_transaction,
            transaction_type=transaction_type,
            amount=amount,
            description=message.strip(),
            category_name=category_name,
            transaction_date=transaction_date or date.today().isoformat(),
        )

        intent.confidence = self._estimate_confidence(intent)
        return self._finalize(intent)

    def _detect_type(self, text: str) -> TransactionTypeEnum | None:
        if self._has_any(text, INCOME_KEYWORDS):
            return TransactionTypeEnum.income
        if self._has_any(text, EXPENSE_KEYWORDS):
            return TransactionTypeEnum.expense
        return None

    def _extract_amount(self, text: str) -> float | None:
        match = _AMOUNT_RE.search(text)
        if not match:
            return None
        raw = match.group(1)
        # Normaliza formato brasileiro.
        if "," in raw:
            # Vírgula é decimal; pontos são separadores de milhar.
            raw = raw.replace(".", "").replace(",", ".")
        elif raw.count(".") == 1 and len(raw.split(".")[1]) == 3:
            # Ex.: "1.250" -> separador de milhar, não decimal.
            raw = raw.replace(".", "")
        try:
            return float(raw)
        except ValueError:
            return None

    def _detect_category(self, text: str) -> str | None:
        for keyword, category in CATEGORY_KEYWORDS.items():
            if keyword in text:
                return category
        return None

    def _detect_date(self, text: str) -> str | None:
        today = date.today()
        if "anteontem" in text:
            return (today - timedelta(days=2)).isoformat()
        if "ontem" in text:
            return (today - timedelta(days=1)).isoformat()
        if "hoje" in text:
            return today.isoformat()
        return None

    def _estimate_confidence(self, intent: FinancialIntent) -> float:
        score = 0.0
        if intent.transaction_type is not None:
            score += 0.4
        if intent.amount is not None:
            score += 0.4
        if intent.category_name is not None:
            score += 0.2
        return round(score, 2)

    def _finalize(self, intent: FinancialIntent) -> FinancialIntent:
        """Marca necessidade de confirmação quando faltam dados essenciais."""
        if intent.intent != IntentType.create_transaction:
            return intent

        if intent.amount is None:
            intent.needs_confirmation = True
            intent.confirmation_question = (
                intent.confirmation_question or "Qual foi o valor do lançamento?"
            )
        elif intent.transaction_type is None:
            intent.needs_confirmation = True
            intent.confirmation_question = (
                intent.confirmation_question
                or "Esse lançamento é uma receita ou uma despesa?"
            )
        elif intent.category_name is None:
            intent.needs_confirmation = True
            intent.confirmation_question = (
                intent.confirmation_question or "Em qual categoria devo registrar?"
            )

        return intent

    @staticmethod
    def _has_any(text: str, keywords: tuple[str, ...]) -> bool:
        return any(keyword in text for keyword in keywords)


intent_classifier = IntentClassifier()
