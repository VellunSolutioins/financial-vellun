"""Cria lançamentos em apps/api a partir de um FinancialIntent confirmado (P3.6).

Conta/cartão e categoria vêm do catálogo do usuário. Quando não dá para
resolvê-los com segurança, :meth:`TransactionCreator.pending_question` devolve a
pergunta a fazer — antes de qualquer gravação.
"""

import logging
from datetime import date

from ..schemas.financial_intent import (
    AccountKindEnum,
    FinancialIntent,
    RecurrenceFrequencyEnum,
    RecurrenceTypeEnum,
)
from .api_client import api_client
from .clock import today_local
from .confirmation_rules import (
    FIELD_ACCOUNT,
    FIELD_CATEGORY,
    Question,
    format_brl,
    total_amount,
)
from .metrics import metrics
from .reply_parsers import match_names, normalize
from .user_catalog import user_catalog

logger = logging.getLogger(__name__)


#: Sufixo com que os cartões aparecem na lista de contas do prompt. O LLM às
#: vezes o devolve junto do nome; o resolvedor o reconhece como cartão.
CARD_SUFFIX = " (cartão de crédito)"

#: Quantas opções a pergunta de conta/categoria lista.
MAX_OPTIONS = 8

FREQUENCY_LABELS = {
    RecurrenceFrequencyEnum.monthly: "mensal",
    RecurrenceFrequencyEnum.bimonthly: "bimestral",
    RecurrenceFrequencyEnum.semiannual: "semestral",
    RecurrenceFrequencyEnum.annual: "anual",
}

NO_ACCOUNT_MESSAGE = (
    "Não encontrei uma conta para registrar. Cadastre uma conta no app "
    "ou diga em qual cartão foi a compra."
)


def is_card(resource: dict) -> bool:
    """A API marca cada item com ``kind``; sem ele (API antiga), é conta comum."""
    return resource.get("kind") == "card"


def display_name(resource: dict) -> str:
    """Nome como aparece no prompt: cartões levam o sufixo que os identifica."""
    return f"{resource['name']}{CARD_SUFFIX}" if is_card(resource) else resource["name"]


def _option_label(resource: dict) -> str:
    return f"{resource['name']} (cartão)" if is_card(resource) else resource["name"]


def _options(names: list[str]) -> str:
    shown = names[:MAX_OPTIONS]
    return ", ".join(shown) + (", …" if len(names) > MAX_OPTIONS else "")


def _destination(resource: dict) -> str:
    return f"no cartão {resource['name']}" if is_card(resource) else f"na conta {resource['name']}"


def _format_date(iso: str) -> str:
    try:
        return date.fromisoformat(iso).strftime("%d/%m/%Y")
    except ValueError:
        return iso


def _split_account_name(account_name: str) -> tuple[str, bool]:
    """Tira o sufixo de cartão do nome; diz se ele estava lá."""
    name = account_name.strip()
    # `normalize` só tira acentos: o tamanho do texto não muda.
    suffix = normalize(CARD_SUFFIX)
    if normalize(name).endswith(suffix):
        return name[: -len(suffix)].strip(), True
    return name, False


def _tx_type(intent: FinancialIntent) -> str:
    return intent.transaction_type.value if intent.transaction_type else "expense"


class TransactionCreator:
    async def pending_question(self, intent: FinancialIntent, user_id: str) -> Question | None:
        """Pergunta sobre conta/cartão ou categoria, se não der para resolvê-los.

        Chamado antes de registrar a extração como confirmada: a pergunta deixa
        o lançamento pendente, e a resposta volta por ``_merge_confirmation_reply``.
        """
        account = await self._resolve_account(user_id, intent)
        if isinstance(account, Question):
            return account
        category = await self._resolve_category(user_id, intent)
        if isinstance(category, Question):
            return category
        return None

    async def create_from_intent(
        self,
        intent: FinancialIntent,
        user_id: str,
        raw_message: str,
        ai_extracted_transaction_id: str | None = None,
        idempotency_key: str | None = None,
        *,
        reference_date: date | None = None,
        original_message: str | None = None,
    ) -> dict:
        """Retorna ``{ok: bool, message: str, transaction?: dict}``.

        ``idempotency_key`` (o ``jobId``) impede que um retry — inclusive um
        timeout ocorrido *depois* de o lancamento ter sido criado — gere um
        segundo lancamento: a API devolve o existente.

        ``reference_date`` é o dia em que a mensagem chegou (padrão da data);
        ``original_message`` é a mensagem que abriu a conversa, quando o
        lançamento foi completado por respostas a perguntas.
        """
        tx_type = _tx_type(intent)
        account = await self._resolve_account(user_id, intent)
        if not isinstance(account, dict):
            return {"ok": False, "message": NO_ACCOUNT_MESSAGE}

        category = await self._resolve_category(user_id, intent)
        category = category if isinstance(category, dict) else None

        source_text = original_message or raw_message
        payload = {
            "userId": user_id,
            "accountId": account["id"],
            "categoryId": category["id"] if category else None,
            "type": tx_type,
            "amount": total_amount(intent),
            "description": intent.description or source_text,
            "transactionDate": intent.transaction_date
            or (reference_date or today_local()).isoformat(),
            "status": "confirmed",
            "source": "whatsapp",
            "rawInput": source_text,
        }
        if intent.recurrence_type == RecurrenceTypeEnum.parcelado:
            payload["recurrenceType"] = "parcelado"
            payload["installments"] = intent.installments
        elif intent.recurrence_type == RecurrenceTypeEnum.fixo:
            payload["recurrenceType"] = "fixo"
            payload["recurrenceFrequency"] = (
                intent.recurrence_frequency or RecurrenceFrequencyEnum.monthly
            ).value
            payload["recurrenceMonths"] = intent.occurrences
        if ai_extracted_transaction_id:
            payload["aiExtractedTransactionId"] = ai_extracted_transaction_id
        if idempotency_key:
            payload["idempotencyKey"] = idempotency_key

        try:
            response = await api_client.post("/internal/transactions/from-ai", json=payload)
        except Exception:  # noqa: BLE001
            logger.exception("Erro de rede ao criar lançamento")
            return {
                "ok": False,
                "message": "Não consegui registrar agora. Tente novamente em instantes.",
            }

        if response.status_code not in (200, 201):
            logger.warning("API recusou lançamento (%s): %s", response.status_code, response.text)
            return {
                "ok": False,
                "message": "Não consegui registrar o lançamento. Verifique os dados e tente de novo.",
            }

        transaction = response.json()
        if isinstance(transaction, dict) and transaction.get("idempotent"):
            metrics.incr("transactions_idempotent_hit")
            logger.info("Lancamento ja existia para esta chave de idempotencia")

        message = self._success_message(intent, payload, account, category)
        return {"ok": True, "message": message, "transaction": transaction}

    @staticmethod
    def _success_message(
        intent: FinancialIntent, payload: dict, account: dict, category: dict | None
    ) -> str:
        """Confirma o que foi gravado — a categoria e a conta **resolvidas**, não
        o nome que o LLM sugeriu."""
        type_label = "Despesa" if payload["type"] == "expense" else "Receita"
        category_label = category["name"] if category else "Sem categoria"
        destination = _destination(account)
        when = _format_date(payload["transactionDate"])
        total = payload["amount"]

        if payload.get("recurrenceType") == "parcelado":
            count = payload["installments"]
            each = int(round(total * 100) // count) / 100
            # No cartão, a data é a da compra: quando a 1ª parcela é cobrada
            # depende do fechamento da fatura, que o agente não conhece.
            start = f"Compra em {when}." if is_card(account) else f"1ª parcela em {when}."
            return (
                f"Lançamento criado! {type_label} parcelada em {count}x de {format_brl(each)} "
                f"(total {format_brl(total)}) em {category_label}, {destination}. {start}"
            )
        if payload.get("recurrenceType") == "fixo":
            frequency = FREQUENCY_LABELS[RecurrenceFrequencyEnum(payload["recurrenceFrequency"])]
            return (
                f"Lançamento criado! {type_label} fixa {frequency} de {format_brl(total)} "
                f"em {category_label}, {destination}, {payload['recurrenceMonths']} vezes "
                f"a partir de {when}."
            )
        return (
            f"Lançamento criado! {type_label} de {format_brl(total)} "
            f"em {category_label}, {destination}, em {when}."
        )

    async def _resolve_account(
        self, user_id: str, intent: FinancialIntent
    ) -> dict | Question | None:
        """Conta comum ou cartão (a conta interna dele) do lançamento.

        - Nome citado: o recurso com esse nome (exato antes de parcial). Sem
          nenhum, ou com mais de um, pergunta — nunca cai em silêncio no padrão.
        - "No cartão", sem nome: o cartão padrão; senão o único cartão; com
          vários, pergunta.
        - Sem menção: o recurso "Padrão nos lançamentos"; sem ele, a conta
          comum mais antiga.

        Receita nunca vai para cartão (a API recusa: devolução é estorno).
        ``None`` só quando o usuário não tem conta nenhuma.
        """
        # Mesma lista que o contexto do LLM já carregou neste job; dentro do
        # escopo de memo isto não gera chamada nova.
        all_resources = await user_catalog.accounts(user_id)
        income = _tx_type(intent) == "income"
        resources = [r for r in all_resources if not (income and is_card(r))]
        if not resources:
            return None

        kind = intent.account_kind
        if intent.account_name:
            name, has_card_suffix = _split_account_name(intent.account_name)
            if has_card_suffix:
                kind = AccountKindEnum.card
            if income:
                kind = AccountKindEnum.account
            pool = [
                r for r in resources if kind is None or is_card(r) == (kind == AccountKindEnum.card)
            ]
            matches = [pool[i] for i in match_names(name, [r["name"] for r in pool])]
            if len(matches) == 1:
                return matches[0]
            if matches:
                return Question(
                    FIELD_ACCOUNT,
                    f"Encontrei mais de uma opção para \"{name}\": "
                    f"{_options([_option_label(r) for r in matches])}. Em qual devo registrar?",
                )
            if income and match_names(name, [r["name"] for r in all_resources if is_card(r)]):
                return Question(
                    FIELD_ACCOUNT,
                    "Cartão não recebe receita. Em qual conta devo registrar? "
                    f"{_options([_option_label(r) for r in resources])}",
                )
            return Question(
                FIELD_ACCOUNT,
                f"Não encontrei \"{name}\" entre suas contas e cartões. Em qual devo registrar? "
                f"{_options([_option_label(r) for r in resources])}",
            )

        cards = [r for r in resources if is_card(r)]
        regular = [r for r in resources if not is_card(r)]
        preferred = next((r for r in resources if r.get("isPreferred")), None)

        if kind == AccountKindEnum.card and not income:
            if preferred is not None and is_card(preferred):
                return preferred
            configured = [c for c in cards if not c.get("needsSetup")]
            if len(cards) == 1:
                return cards[0]
            if len(configured) == 1:
                return configured[0]
            if cards:
                return Question(
                    FIELD_ACCOUNT,
                    f"Em qual cartão? {_options([r['name'] for r in cards])}",
                )
            return Question(
                FIELD_ACCOUNT,
                "Não encontrei cartão cadastrado. Em qual conta devo registrar? "
                f"{_options([_option_label(r) for r in resources])}",
            )

        if preferred is not None and not (kind == AccountKindEnum.account and is_card(preferred)):
            return preferred
        if regular:
            return regular[0]
        # Só cartões e nenhum padrão: não dá para escolher por ele.
        return Question(
            FIELD_ACCOUNT,
            f"Em qual cartão devo registrar? {_options([r['name'] for r in cards])}",
        )

    async def _resolve_category(
        self, user_id: str, intent: FinancialIntent
    ) -> dict | Question | None:
        """Categoria do tipo do lançamento (receita ou despesa).

        Sem categoria, ou com um nome que não existe, pergunta listando as
        opções — antes gravava sem categoria e a resposta dizia "em <nome>".
        ``None`` quando o catálogo não veio (API fora): grava sem categoria em
        vez de perguntar algo que não daria para conferir.
        """
        categories = await user_catalog.categories(user_id)
        tx_type = _tx_type(intent)
        # Sem `type` (API antiga) a categoria serve para os dois.
        typed = [c for c in categories if c.get("type") in (None, tx_type)]
        if not typed:
            return None
        names = [c["name"] for c in typed]

        if not intent.category_name:
            return Question(
                FIELD_CATEGORY,
                f"Em qual categoria devo registrar esse lançamento? {_options(names)}",
            )
        matches = match_names(intent.category_name, names)
        if matches:
            return typed[matches[0]]
        return Question(
            FIELD_CATEGORY,
            f"Não encontrei a categoria \"{intent.category_name}\". "
            f"Em qual destas devo registrar? {_options(names)}",
        )


transaction_creator = TransactionCreator()
