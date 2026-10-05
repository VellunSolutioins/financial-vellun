"""Interpretador de mensagens em linguagem natural.

Estratégia principal: LLM (quando configurado). Fallback: regras simples
(regex + dicionário de palavras-chave), garantindo que o fluxo continue
funcionando mesmo sem `OPENAI_API_KEY`.
"""

import logging
import re
import time
from datetime import date

from ..schemas.financial_intent import (
    AccountKindEnum,
    FinancialIntent,
    IntentType,
    RecurrenceTypeEnum,
    TransactionTypeEnum,
)
from .clock import today_local
from .llm.base import LlmProvider
from .llm.factory import create_llm_provider
from .metrics import metrics
from .reply_parsers import (
    detect_recurrence,
    match_names,
    normalize,
    parse_amount,
    parse_date,
    tokens,
)

logger = logging.getLogger(__name__)

EXPENSE_KEYWORDS = (
    "gastei", "paguei", "comprei", "compra", "gasto", "despesa", "gastando", "pagamento",
)
INCOME_KEYWORDS = (
    "recebi", "ganhei", "recebimento", "entrou", "receita", "caiu", "vendi", "venda",
)
QUERY_KEYWORDS = ("resumo", "saldo", "quanto", "balanço", "balanco", "relatório", "relatorio")
HELP_KEYWORDS = ("ajuda", "help", "socorro", "como funciona", "o que voce faz", "o que você faz")
CANCEL_KEYWORDS = ("cancela", "cancelar", "apaga", "apagar", "desfaz", "desfazer", "remove")
CORRECT_KEYWORDS = ("corrige", "corrigir", "errei", "na verdade", "muda", "mudar", "ajusta")
# Dinheiro que só muda de lugar entre contas do usuário: não é receita nem
# despesa (docs/adrs/0018). O agente não registra; orienta a usar o app.
MOVEMENT_KEYWORDS = (
    "entre minhas contas", "para minha conta", "pra minha conta", "da minha conta para",
    "transferi para a poupança", "transferi pra poupança", "para a poupança",
    "apliquei", "aportei", "aporte", "resgatei", "resgate",
    "empréstimo", "emprestimo", "financiamento", "amortizei", "amortização", "amortizacao",
)
# A IA só escolhe conta ou cartão quando a mensagem diz (docs/adrs/0020): sem
# um destes sinais, vale o padrão do usuário. Comparados sem acento.
ACCOUNT_HINT_RE = re.compile(
    # "da conta de luz" é a conta que se paga, não a conta bancária.
    r"\b(n[ao]|d[ao]|pel[ao]|minha) conta\b(?! de\b)"
    r"|\bdebito\b|\bpix\b|\bdinheiro\b|\bespecie\b|\btransferi"
)
CARD_HINT_RE = re.compile(r"\bcartao\b|\bcredito\b|\bfatura\b")
#: Palavras de nome de conta que não identificam nenhuma em particular.
GENERIC_ACCOUNT_WORDS = frozenset(
    {"conta", "cartao", "credito", "debito", "de", "do", "da", "corrente", "poupanca"}
)

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

_UNSET = object()


def _reference_date(context: dict) -> date:
    """"Hoje" da mensagem: a data do contexto (quando ela chegou) ou o dia atual."""
    try:
        return date.fromisoformat(context["today"])
    except (KeyError, TypeError, ValueError):
        return today_local()


def _catalog_names(context: dict, tx_type: TransactionTypeEnum | None) -> list[str] | None:
    """Categorias do usuário compatíveis com o tipo; ``None`` sem catálogo."""
    typed_key = {
        TransactionTypeEnum.income: "income_categories",
        TransactionTypeEnum.expense: "expense_categories",
    }.get(tx_type)
    names = context.get(typed_key) if typed_key and typed_key in context else None
    if names is None:
        names = context.get("categories")
    return list(names) if names else None


class IntentClassifier:
    def __init__(self, provider: LlmProvider | None | object = _UNSET) -> None:
        # `provider` ausente -> usa a factory; `provider=None` -> apenas regras;
        # uma instância -> injeção explícita (útil em testes).
        if provider is _UNSET:
            self._provider: LlmProvider | None = create_llm_provider()
        else:
            self._provider = provider  # type: ignore[assignment]

    async def classify(self, message: str, user_context: dict | None = None) -> FinancialIntent:
        # `context` carrega `recent_messages` (histórico) além de categorias/
        # contas/data; é repassado integralmente ao provider de LLM. O fallback
        # de regras ignora o histórico, mas não quebra com ele presente.
        context = user_context or {}

        if self._provider is not None:
            started = time.monotonic()
            try:
                intent = await self._provider.extract_intent(message, context)
                metrics.incr("llm_success")
                metrics.observe_ms("llm_latency_ms", (time.monotonic() - started) * 1000)
                if self._should_prefer_rule_transaction(message, intent):
                    logger.info(
                        "LLM classificou como %s, mas a mensagem parece novo lançamento; "
                        "usando regras",
                        intent.intent,
                    )
                    return self._classify_with_rules(message, context)
                return self._finalize(self._reconcile_with_rules(message, intent))
            except Exception:  # noqa: BLE001 — falha do LLM aciona o fallback
                metrics.incr("llm_fallback")
                logger.warning("LLM falhou; usando fallback de regras", exc_info=True)

        return self._classify_with_rules(message, context)

    def classify_with_rules(self, message: str, context: dict | None = None) -> FinancialIntent:
        """Classificação síncrona apenas por regras (útil para respostas de confirmação)."""
        return self._classify_with_rules(message, context or {})

    async def classify_image(
        self, image_bytes: bytes, mime: str, caption: str | None, context: dict | None = None
    ) -> FinancialIntent | None:
        """Extrai a intenção de uma imagem (comprovante) via LLM de visão.

        Retorna ``None`` quando não há provider com suporte a visão ou em falha —
        sinalizando ao chamador para responder com uma mensagem de fallback.
        """
        if self._provider is None or not self._provider.supports_vision:
            return None
        try:
            intent = await self._provider.extract_intent_from_image(
                image_bytes, mime, caption, context or {}
            )
            metrics.incr("vision_success")
            return self._finalize(intent)
        except Exception:  # noqa: BLE001 — sem fallback de regras para imagem
            metrics.incr("vision_fail")
            logger.warning("Falha na extração por visão", exc_info=True)
            return None

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
        if self._has_any(text, MOVEMENT_KEYWORDS) and not self._has_any(
            text, ("juros", "tarifa", "rendimento", "rendeu")
        ):
            return FinancialIntent(intent=IntentType.unsupported_movement, confidence=0.8)

        transaction_type = self._detect_type(text)
        amount = self._extract_amount(text)
        if amount is None and transaction_type is None:
            # Sem valor e sem verbo de gasto/receita ("oi", "tudo bem?"): não é
            # um lançamento. Antes virava "Não identifiquei o valor…".
            return FinancialIntent(intent=IntentType.unknown, confidence=0.3)

        category_name = self._detect_category(text, context, transaction_type)
        today = _reference_date(context)
        transaction_date = parse_date(text, today) or today
        recurrence = detect_recurrence(text)

        intent = FinancialIntent(
            intent=IntentType.create_transaction,
            transaction_type=transaction_type,
            amount=amount,
            description=message.strip(),
            category_name=category_name,
            transaction_date=transaction_date.isoformat(),
            recurrence_type=recurrence.recurrence_type,
            installments=recurrence.installments,
            amount_basis=recurrence.amount_basis,
            recurrence_frequency=recurrence.frequency,
            occurrences=recurrence.occurrences,
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
        # Ignora datas, "10x" e "12 meses": em "10x de 300" o valor é 300.
        return parse_amount(text)

    def _detect_category(
        self, text: str, context: dict, tx_type: TransactionTypeEnum | None
    ) -> str | None:
        """Categoria pela palavra-chave, desde que exista no catálogo do usuário.

        O dicionário tem nomes dos dois perfis (PF e PJ): sem a checagem, um
        "aluguel" sugeria uma categoria que o usuário nem tem. Sem catálogo
        (API fora), vale o nome padrão.
        """
        names = _catalog_names(context, tx_type)
        for keyword, category in CATEGORY_KEYWORDS.items():
            if keyword not in text:
                continue
            if names is None:
                return category
            matches = match_names(category, names)
            if matches:
                return names[matches[0]]
        # O próprio nome de uma categoria do usuário citado na mensagem ("pets").
        normalized = normalize(text)
        for name in names or []:
            if len(name) >= 3 and normalize(name) in normalized:
                return name
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

    def _reconcile_with_rules(self, message: str, intent: FinancialIntent) -> FinancialIntent:
        """Confere a extração do LLM com o que a mensagem diz literalmente.

        O LLM já trocou "gasto de 36,65 em 2x" (total) por "2x de 36,65"
        (parcela) e gravou o dobro. Onde a frase tem sinal inequívoco — "em
        2x", "V em Nx", "Nx de V" —, vale a regra; sem sinal, fica o LLM.
        """
        if intent.intent != IntentType.create_transaction:
            return intent

        hint = detect_recurrence(message)
        if hint.recurrence_type == RecurrenceTypeEnum.parcelado and hint.installments:
            if intent.recurrence_type != RecurrenceTypeEnum.parcelado:
                self._override(intent, "recurrence_type", RecurrenceTypeEnum.parcelado)
                intent.recurrence_frequency = None
                intent.occurrences = None
            if intent.installments != hint.installments:
                self._override(intent, "installments", hint.installments)

        if intent.recurrence_type == RecurrenceTypeEnum.parcelado:
            if hint.basis_ambiguous:
                # Os dois formatos na frase: pergunta em vez de confiar no LLM.
                if intent.amount_basis is not None:
                    self._override(intent, "amount_basis", None)
            elif hint.amount_basis is not None and intent.amount_basis != hint.amount_basis:
                self._override(intent, "amount_basis", hint.amount_basis)

            # O prompt pede para não multiplicar nem dividir; se o LLM fez a
            # conta, volta o número que o usuário digitou.
            typed = parse_amount(message.lower())
            count = intent.installments
            if typed and count and intent.amount and intent.amount != typed:
                if any(
                    abs(intent.amount - candidate) < 0.011
                    for candidate in (typed * count, typed / count)
                ):
                    self._override(intent, "amount", typed)

        # "Outros" é o curinga do LLM quando nada se encaixa; o combinado é
        # perguntar, a menos que o próprio usuário tenha dito "outros".
        if (
            intent.category_name
            and normalize(intent.category_name) == "outros"
            and not re.search(r"\boutros?\b", normalize(message))
        ):
            self._override(intent, "category_name", None)

        self._drop_unmentioned_account(message, intent)
        return intent

    def _drop_unmentioned_account(self, message: str, intent: FinancialIntent) -> None:
        """Conta ou cartão só valem se a mensagem disser (docs/adrs/0020).

        Em produção o LLM devolvia ``account_kind="account"`` (e às vezes o
        nome da conta mais óbvia) para "compra de capa do celular no valor de
        38,60". Isso passava por cima do cartão que o usuário marcou como
        padrão. Sem sinal no texto, os campos são anulados e quem decide é
        ``transaction_creator._resolve_account``: o padrão do usuário.
        """
        text = normalize(message)
        words = set(tokens(message))

        if intent.account_name:
            name_words = tokens(intent.account_name)
            distinctive = [w for w in name_words if w not in GENERIC_ACCOUNT_WORDS]
            # Nome só de palavras genéricas ("Conta corrente"): precisa vir inteiro.
            mentioned = (
                any(w in words for w in distinctive)
                if distinctive
                else bool(name_words) and all(w in words for w in name_words)
            )
            if not mentioned:
                self._override(intent, "account_name", None)

        names_card = bool(intent.account_name) and "(cartao de credito)" in normalize(
            intent.account_name
        )
        names_account = bool(intent.account_name) and not names_card
        if (
            intent.account_kind == AccountKindEnum.account
            and not names_account
            and not ACCOUNT_HINT_RE.search(text)
        ):
            self._override(intent, "account_kind", None)
        elif (
            intent.account_kind == AccountKindEnum.card
            and not names_card
            and not CARD_HINT_RE.search(text)
        ):
            self._override(intent, "account_kind", None)

    @staticmethod
    def _override(intent: FinancialIntent, field: str, value: object) -> None:
        logger.info(
            "Regras sobrescreveram %s do LLM: %r -> %r", field, getattr(intent, field), value
        )
        metrics.incr(f"llm_rules_override_{field}")
        setattr(intent, field, value)

    def _should_prefer_rule_transaction(self, message: str, intent: FinancialIntent) -> bool:
        text = message.lower().strip()
        if intent.intent not in (IntentType.cancel_last, IntentType.correct_last):
            return False
        if self._has_any(text, CANCEL_KEYWORDS + CORRECT_KEYWORDS):
            return False
        return self._extract_amount(text) is not None and self._detect_type(text) is not None

    @staticmethod
    def _has_any(text: str, keywords: tuple[str, ...]) -> bool:
        return any(keyword in text for keyword in keywords)


intent_classifier = IntentClassifier()
