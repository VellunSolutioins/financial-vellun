"""Baixa de contas em aberto e pagamento de fatura pelo WhatsApp.

Fase 2 do plano ``docs/plans/018-agente-acoes-whatsapp.md`` (ADR 0024). Toda
ação que mexe em dinheiro **mostra o que vai acontecer e espera um "sim"**; o
``jobId`` da mensagem do "sim" é a chave de idempotência, para um retry não
pagar duas vezes.

O estado entre as mensagens fica em ``ConversationState.pending_action``, um
dict serializável:

- ``kind``: ``settle`` (dar baixa) ou ``pay_invoice``;
- ``step``: ``choose`` (responder o número da lista) ou ``confirm`` (sim/não);
- ``pick``: o que a lista escolhe — ``target`` (a conta), ``card`` ou ``account``;
- ``options``: os itens da lista;
- ``target``, ``card``, ``invoice``, ``account``, ``amount``, ``date``;
- ``fallback``: o lançamento a criar se o usuário disser "não" à oferta de
  baixa feita ao registrar um gasto (ver :meth:`ActionProcessor.offer_settlement`).

As regras financeiras ficam na API; aqui só a conversa.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from uuid import uuid4

from ..messaging.base import TransientError
from ..schemas.financial_intent import (
    FinancialIntent,
    IntentType,
    RecurrenceTypeEnum,
    TransactionTypeEnum,
)
from . import reply_parsers as parsers
from .api_client import api_client
from .clock import today_local
from .confirmation_rules import format_brl, total_amount
from .conversation_manager import conversation_manager
from .metrics import metrics
from .target_resolver import label_matches, rank_open_items, strong_match, subject_tokens
from .transaction_creator import is_card, transaction_creator
from .user_catalog import user_catalog

logger = logging.getLogger(__name__)

SETTLE = "settle"
PAY_INVOICE = "pay_invoice"
STEP_CHOOSE = "choose"
STEP_CONFIRM = "confirm"
PICK_TARGET = "target"
PICK_CARD = "card"
PICK_ACCOUNT = "account"

#: Quantas opções a lista mostra.
MAX_OPTIONS = 5
#: Respostas seguidas que não respondem à pergunta antes de desistir.
MAX_REPLY_ATTEMPTS = 2
#: Diferença de valor desprezada (centavo).
TOLERANCE = 0.01

INVOICE_UNAVAILABLE = (
    "Para registrar o pagamento da fatura, use o app: em Faturas, toque em Pagar."
)
PAYMENTS_UNAVAILABLE = (
    "Dar baixa pelo WhatsApp não está disponível no momento. Use o app: em Lançamentos, "
    "toque em Pagar ou Receber."
)
NOTHING_DONE = "Ok, não mexi em nada."
GAVE_UP = (
    "Não consegui entender a resposta, então deixei isso de lado. "
    "Pode mandar de novo quando quiser."
)
API_ERROR = "Não consegui consultar suas contas agora. Tente de novo em instantes."
NO_CARD = (
    "Não encontrei cartão de crédito cadastrado. Cadastre o cartão no app para registrar "
    "o pagamento da fatura."
)
NO_ACCOUNT = "Não encontrei uma conta para tirar o dinheiro. Cadastre uma conta no app."
CONFIRM_HINT = "\nResponda *sim* ou *não*."


class FeatureDisabled(Exception):
    """A rota respondeu ``403 FEATURE_DISABLED``: ``whatsapp_payments`` desligada."""


class Refused(Exception):
    """A API recusou a operação (400/404/409); ``message`` é para o usuário."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass
class ActionOutcome:
    """O que o ``message_processor`` faz em seguida.

    - ``text``: responder isto;
    - ``resume_intent``: seguir criando este lançamento (``text`` vai antes da
      resposta da criação, como aviso);
    - ``new_message``: a resposta era uma mensagem nova; processar do zero.
    """

    text: str = ""
    resume_intent: FinancialIntent | None = None
    original_message: str | None = None
    reference_date: date | None = None
    new_message: bool = False


# ── Chamadas à API ───────────────────────────────────────────────────────────
def _body(response) -> dict:
    try:
        body = response.json()
    except Exception:  # noqa: BLE001
        return {}
    return body if isinstance(body, dict) else {}


def _api_message(response) -> str:
    message = _body(response).get("message")
    if isinstance(message, list):
        message = " ".join(str(m) for m in message)
    return str(message or "a operação foi recusada.")


def _disabled(response) -> bool:
    return response.status_code == 403 and _body(response).get("code") == "FEATURE_DISABLED"


async def _open_items(user_id: str, kind: str) -> dict:
    response = await api_client.get(f"/internal/users/{user_id}/open-items", params={"type": kind})
    if _disabled(response):
        raise FeatureDisabled
    if response.status_code != 200:
        raise RuntimeError(f"open-items respondeu {response.status_code}")
    return response.json()


async def _post(path: str, body: dict) -> dict:
    """POST de uma ação. Falha de transporte ou 5xx levanta ``TransientError``:
    o job é retentado com o mesmo ``jobId`` e a API devolve o que já fez."""
    try:
        response = await api_client.post(path, json=body)
    except Exception as exc:  # noqa: BLE001
        raise TransientError(f"API indisponível ao executar ação: {type(exc).__name__}") from exc
    if response.status_code in (200, 201):
        return response.json()
    if _disabled(response):
        raise FeatureDisabled
    if response.status_code in (400, 404, 409):
        raise Refused(_api_message(response))
    raise TransientError(f"ação respondeu {response.status_code}")


async def unparsed_reply(
    phone: str, contact: dict | None, state, action: dict, reply: str, retry: str
) -> ActionOutcome:
    """Resposta que não responde à pergunta de uma ação pendente: mensagem
    nova (frase longa), nova tentativa ou desistência."""
    if len(parsers.tokens(reply)) >= 3:
        # "gastei 30 no uber" no meio da pergunta: é outra coisa.
        await conversation_manager.clear(phone)
        metrics.incr("action_replaced_by_new_message")
        return ActionOutcome(new_message=True)
    attempts = state.attempts + 1
    if attempts > MAX_REPLY_ATTEMPTS:
        await conversation_manager.clear(phone)
        metrics.incr("action_abandoned")
        return ActionOutcome(text=GAVE_UP)
    await conversation_manager.set_action(phone, action, contact, attempts=attempts)
    return ActionOutcome(text=f"Não entendi. {retry}")


# ── Textos ───────────────────────────────────────────────────────────────────
def _day(iso: str | None) -> str:
    try:
        return date.fromisoformat((iso or "")[:10]).strftime("%d/%m")
    except ValueError:
        return iso or ""


def _due(item: dict, income: bool) -> str:
    when = _day(item.get("dueDate"))
    if income:
        return f"atrasada, era para {when}" if item.get("isOverdue") else f"prevista para {when}"
    return f"venceu {when}" if item.get("isOverdue") else f"vence {when}"


def _when(iso: str) -> str:
    return "hoje" if iso == today_local().isoformat() else f"em {_day(iso)}"


def _entry_label(item: dict, income: bool) -> str:
    return f"{item['description']} — {format_brl(item['remaining'])} — {_due(item, income)}"


def _invoice_label(invoice: dict) -> str:
    return (
        f"Fatura {invoice['cardName']} — {format_brl(invoice['remaining'])} — "
        f"{_due(invoice, False)}"
    )


def _list_question(title: str, labels: list[str]) -> str:
    lines = [title]
    lines += [f"{n}. {label}" for n, label in enumerate(labels, start=1)]
    lines.append("Responda com o número, ou *não* para cancelar.")
    return "\n".join(lines)


def _payment_date(intent: FinancialIntent, reference: date) -> str:
    """A data dita, se não for futura (a API recusa); senão, o dia da mensagem."""
    try:
        said = date.fromisoformat((intent.transaction_date or "")[:10])
    except ValueError:
        said = None
    day = said if said is not None and said <= today_local() else min(reference, today_local())
    return day.isoformat()


def _as_creation(intent: FinancialIntent) -> FinancialIntent:
    created = intent.model_copy(deep=True)
    created.intent = IntentType.create_transaction
    if created.transaction_type is None:
        created.transaction_type = TransactionTypeEnum.expense
    return created


def _is_fixed(item: dict) -> bool:
    return item.get("recurrenceType") == "fixo"


class ActionProcessor:
    # ── Dar baixa ───────────────────────────────────────────────────────────
    async def start_settle(
        self,
        phone: str,
        contact: dict | None,
        user_id: str,
        intent: FinancialIntent,
        reference: date,
        raw_message: str,
    ) -> ActionOutcome:
        """"Paguei a luz": procura a conta em aberto e pergunta antes de dar baixa.

        Sem nada parecido em aberto, ou com a flag desligada, segue como
        lançamento novo — o comportamento de antes da Fase 2.
        """
        income = intent.transaction_type == TransactionTypeEnum.income
        kind = "income" if income else "expense"
        try:
            items = await _open_items(user_id, kind)
        except FeatureDisabled:
            metrics.incr("action_disabled")
            return ActionOutcome(resume_intent=_as_creation(intent))
        except Exception:  # noqa: BLE001
            metrics.incr("action_api_failed")
            logger.exception("Falha ao buscar itens em aberto")
            return ActionOutcome(text=API_ERROR)

        entries = items.get("entries") or []
        words = subject_tokens(intent.description, raw_message)
        candidates = rank_open_items(
            entries, words=words, category=intent.category_name, amount=intent.amount
        )
        if not candidates:
            if intent.amount:
                # "Paguei 120 de luz" sem Luz em aberto é só um gasto: segue sem
                # aviso, como qualquer lançamento.
                return ActionOutcome(resume_intent=_as_creation(intent))
            if not entries and not words and not intent.category_name:
                what = "a receber" if income else "a pagar"
                return ActionOutcome(text=f"Você não tem nada {what} em aberto. 🎉")
            subject = " ".join(words) or intent.category_name or ("receita" if income else "conta")
            novo = "uma receita nova" if income else "um gasto novo"
            note = f"Não encontrei *{subject}* em aberto, então vou registrar como {novo}.\n"
            return ActionOutcome(text=note, resume_intent=_as_creation(intent))

        action = {
            "kind": SETTLE,
            "type": kind,
            "amount": intent.amount,
            "date": _payment_date(intent, reference),
            "account": await self._named_account(user_id, intent.account_name),
            "fallback": None,
        }
        if len(candidates) == 1:
            return await self._ask_confirm(phone, contact, action, target=candidates[0])
        options = candidates[:MAX_OPTIONS]
        action.update(step=STEP_CHOOSE, pick=PICK_TARGET, options=options)
        await conversation_manager.set_action(phone, action, contact)
        title = "Qual destas você recebeu?" if income else "Qual destas você pagou?"
        return ActionOutcome(
            text=_list_question(title, [_entry_label(o, income) for o in options])
        )

    async def offer_settlement(
        self,
        phone: str,
        contact: dict | None,
        user_id: str,
        intent: FinancialIntent,
        raw_message: str,
        original_message: str,
        reference: date,
    ) -> str | None:
        """Antes de criar um gasto ou receita **em conta**, oferece dar baixa no
        item em aberto que ele provavelmente quita ("paguei 120 de luz" com a
        Luz de R$ 120 em aberto). Devolve a pergunta, ou ``None`` para seguir
        criando. Não levanta: na dúvida, cria como antes.
        """
        if (
            intent.intent != IntentType.create_transaction
            or intent.transaction_type is None
            or not intent.amount
            or intent.recurrence_type != RecurrenceTypeEnum.avulso
        ):
            return None
        income = intent.transaction_type == TransactionTypeEnum.income
        try:
            # Primeiro os itens em aberto: com a flag desligada, para aqui.
            items = await _open_items(user_id, "income" if income else "expense")
            if not items.get("entries"):
                return None
            account = await transaction_creator.resolve_account(user_id, intent)
            if not isinstance(account, dict) or is_card(account):
                return None  # no cartão quem paga é a fatura
        except FeatureDisabled:
            return None
        except Exception:  # noqa: BLE001
            logger.warning("Oferta de baixa indisponível; criando o lançamento", exc_info=True)
            return None

        try:
            on = date.fromisoformat((intent.transaction_date or "")[:10])
        except ValueError:
            on = reference
        match = strong_match(
            items.get("entries") or [],
            words=subject_tokens(intent.description, original_message, raw_message),
            category=intent.category_name,
            amount=total_amount(intent),
            on=on,
        )
        if match is None:
            return None

        metrics.incr("open_item_offered")
        action = {
            "kind": SETTLE,
            "type": "income" if income else "expense",
            "step": STEP_CONFIRM,
            "target": match,
            "amount": None,
            "date": _payment_date(intent, reference),
            # Conta citada vale; sem citação, a do próprio lançamento em aberto.
            "account": (
                {"id": account["id"], "name": account["name"]} if intent.account_name else None
            ),
            "fallback": {
                "intent": intent.model_dump(mode="json"),
                "original": original_message,
                "reference": reference.isoformat(),
            },
        }
        await conversation_manager.set_action(phone, action, contact)
        what = "o recebimento" if income else "o pagamento"
        mark = "marcar como recebida" if income else "marcar como paga"
        novo = "registrar uma receita nova" if income else "registrar um gasto novo"
        return (
            f"Você tem *{match['description']} — {format_brl(match['remaining'])}* em aberto "
            f"({_due(match, income)}). É {what} dela?\n"
            f"Responda *sim* para {mark} ou *não* para {novo}."
        )

    # ── Pagar fatura ────────────────────────────────────────────────────────
    async def start_invoice(
        self,
        phone: str,
        contact: dict | None,
        user_id: str,
        intent: FinancialIntent,
        reference: date,
        raw_message: str,
    ) -> ActionOutcome:
        """"Paguei a fatura do Nubank": escolhe cartão, fatura e conta, e confirma."""
        try:
            items = await _open_items(user_id, "expense")
            resources = await user_catalog.accounts(user_id)
        except FeatureDisabled:
            metrics.incr("action_disabled")
            return ActionOutcome(text=INVOICE_UNAVAILABLE)
        except Exception:  # noqa: BLE001
            metrics.incr("action_api_failed")
            logger.exception("Falha ao buscar faturas em aberto")
            return ActionOutcome(text=API_ERROR)

        cards = [r for r in resources if is_card(r) and r.get("cardId")]
        if not cards:
            return ActionOutcome(text=NO_CARD)
        invoices = items.get("invoices") or []
        action = {
            "kind": PAY_INVOICE,
            "type": "expense",
            "amount": intent.amount,
            "date": _payment_date(intent, reference),
            "account": await self._named_account(user_id, intent.account_name),
            "invoices": invoices,
            "fallback": None,
        }

        hint = intent.card_name or intent.account_name or ""
        names = [c["name"] for c in cards]
        named = [cards[i] for i in parsers.match_names(hint, names)] if hint else []
        if not named:
            named = [cards[i] for i in label_matches(raw_message, names)]
        if len(named) == 1:
            return await self._with_card(phone, contact, user_id, action, named[0])

        with_open = [c for c in (named or cards) if self._oldest_invoice(invoices, c)]
        if not with_open:
            return ActionOutcome(text="Você não tem fatura de cartão em aberto. 🎉")
        if len(with_open) == 1:
            return await self._with_card(phone, contact, user_id, action, with_open[0])
        options = [
            {"id": c["cardId"], "name": c["name"], "cardId": c["cardId"]}
            for c in with_open[:MAX_OPTIONS]
        ]
        action.update(step=STEP_CHOOSE, pick=PICK_CARD, options=options)
        await conversation_manager.set_action(phone, action, contact)
        labels = [_invoice_label(self._oldest_invoice(invoices, c)) for c in options]
        return ActionOutcome(text=_list_question("De qual cartão é a fatura?", labels))

    @staticmethod
    def _oldest_invoice(invoices: list[dict], card: dict) -> dict | None:
        """A fatura a pagar do cartão: a vencida, senão a que vence antes."""
        own = [i for i in invoices if i.get("cardId") == card.get("cardId")]
        own.sort(key=lambda i: (not i.get("isOverdue"), i.get("dueDate") or ""))
        return own[0] if own else None

    async def _with_card(
        self, phone: str, contact: dict | None, user_id: str, action: dict, card: dict
    ) -> ActionOutcome:
        invoice = self._oldest_invoice(action.get("invoices") or [], card)
        if invoice is None:
            await conversation_manager.clear(phone)
            return ActionOutcome(text=f"A fatura do {card['name']} não tem nada em aberto. 🎉")
        action["card"] = {"cardId": card["cardId"], "name": card["name"]}
        action["invoice"] = invoice
        if action.get("account") is None:
            regular = [r for r in await user_catalog.accounts(user_id) if not is_card(r)]
            preferred = next((r for r in regular if r.get("isPreferred")), None)
            if preferred is not None or len(regular) == 1:
                chosen = preferred or regular[0]
                action["account"] = {"id": chosen["id"], "name": chosen["name"]}
            elif not regular:
                await conversation_manager.clear(phone)
                return ActionOutcome(text=NO_ACCOUNT)
            else:
                options = [{"id": r["id"], "name": r["name"]} for r in regular[:MAX_OPTIONS]]
                action.update(step=STEP_CHOOSE, pick=PICK_ACCOUNT, options=options)
                await conversation_manager.set_action(phone, action, contact)
                return ActionOutcome(
                    text=_list_question(
                        "De qual conta saiu o pagamento?", [o["name"] for o in options]
                    )
                )
        return await self._ask_confirm(phone, contact, action)

    # ── Resposta às perguntas ───────────────────────────────────────────────
    async def handle_reply(
        self,
        phone: str,
        contact: dict | None,
        state,
        reply: str,
        idempotency_key: str | None,
    ) -> ActionOutcome:
        """Resposta à lista ou à confirmação de uma ação pendente."""
        action = dict(state.pending_action or {})
        user_id = state.user_id
        if action.get("step") == STEP_CONFIRM:
            if parsers.is_negative(reply):
                await conversation_manager.clear(phone)
                fallback = action.get("fallback")
                if fallback:
                    metrics.incr("open_item_offer_declined")
                    return ActionOutcome(
                        resume_intent=FinancialIntent(**fallback["intent"]),
                        original_message=fallback.get("original"),
                        reference_date=date.fromisoformat(fallback["reference"]),
                    )
                metrics.incr("action_cancelled")
                return ActionOutcome(text=NOTHING_DONE)
            if parsers.is_affirmative(reply):
                key = idempotency_key or f"wa-{uuid4()}"
                text = await self._execute(user_id, action, key)
                await conversation_manager.clear(phone)
                return ActionOutcome(text=text)
            return await self._unparsed(
                phone, contact, state, action, reply, self._confirm_text(action)
            )

        if parsers.is_negative(reply):
            await conversation_manager.clear(phone)
            metrics.incr("action_cancelled")
            return ActionOutcome(text=NOTHING_DONE)
        options = action.get("options") or []
        index = self._pick(reply, action)
        if index is None:
            retry = f"Responda com o número da lista (1 a {len(options)}) ou *não* para cancelar."
            return await self._unparsed(phone, contact, state, action, reply, retry)
        chosen = options[index]
        action.pop("options", None)
        pick = action.pop("pick", None)
        if pick == PICK_TARGET:
            return await self._ask_confirm(phone, contact, action, target=chosen)
        if pick == PICK_CARD:
            return await self._with_card(phone, contact, user_id, action, chosen)
        action["account"] = {"id": chosen["id"], "name": chosen["name"]}
        return await self._ask_confirm(phone, contact, action)

    def _pick(self, reply: str, action: dict) -> int | None:
        options = action.get("options") or []
        number = parsers.parse_int(reply)
        if number is not None and 1 <= number <= len(options):
            return number - 1
        if action.get("pick") == PICK_TARGET:
            labels = [o.get("description") or "" for o in options]
        else:
            labels = [o.get("name") or "" for o in options]
        hits = label_matches(reply, labels)
        return hits[0] if len(hits) == 1 else None

    async def _unparsed(
        self, phone: str, contact: dict | None, state, action: dict, reply: str, retry: str
    ) -> ActionOutcome:
        return await unparsed_reply(phone, contact, state, action, reply, retry)

    # ── Confirmação e execução ──────────────────────────────────────────────
    async def _ask_confirm(
        self, phone: str, contact: dict | None, action: dict, *, target: dict | None = None
    ) -> ActionOutcome:
        if target is not None:
            action["target"] = target
            remaining = target.get("remaining") or 0
            amount = action.get("amount")
            if amount is not None and amount > remaining + TOLERANCE and not _is_fixed(target):
                # A API recusa pagar mais do que falta (só o fixo aceita: é o
                # valor real). Propõe quitar o que falta.
                action["said"] = amount
                action["amount"] = None
        action["step"] = STEP_CONFIRM
        await conversation_manager.set_action(phone, action, contact)
        return ActionOutcome(text=self._confirm_text(action))

    @staticmethod
    def _confirm_text(action: dict) -> str:
        when = _when(action["date"])
        if action["kind"] == PAY_INVOICE:
            invoice = action["invoice"]
            remaining = invoice["remaining"]
            amount = action.get("amount") or remaining
            text = (
                f"Registrar o pagamento de {format_brl(amount)} da fatura "
                f"*{action['card']['name']}* ({_due(invoice, False)}), saindo da conta "
                f"{action['account']['name']}, {when}?"
            )
            if amount < remaining - TOLERANCE:
                text += f" Vão faltar {format_brl(remaining - amount)} na fatura."
            elif amount > remaining + TOLERANCE:
                text += (
                    f" O que passar de {format_brl(remaining)} fica como crédito no cartão."
                )
            return text + CONFIRM_HINT

        target = action["target"]
        income = action["type"] == "income"
        remaining = target.get("remaining") or 0
        amount = action.get("amount")
        account = (action.get("account") or {}).get("name") or target.get("accountName")
        flow = ""
        if account:
            flow = f", entrando na conta {account}" if income else f", saindo da conta {account}"
        verb = "recebida" if income else "paga"
        name = target["description"]
        if amount is None or abs(amount - remaining) < TOLERANCE:
            text = ""
            if action.get("said"):
                text = (
                    f"*{name}* tem {format_brl(remaining)} em aberto e você disse "
                    f"{format_brl(action['said'])}. "
                )
            text += (
                f"Marcar como {verb} *{name} — {format_brl(remaining)}* "
                f"({_due(target, income)}){flow}, {when}?"
            )
        elif amount > remaining:
            text = (
                f"Marcar como {verb} *{name}* pelo valor de {format_brl(amount)} "
                f"(previsto: {format_brl(remaining)}){flow}, {when}?"
            )
        else:
            what = "recebimento" if income else "pagamento"
            text = (
                f"Registrar {what} de {format_brl(amount)} em *{name}* (em aberto: "
                f"{format_brl(remaining)}){flow}, {when}? Vão faltar "
                f"{format_brl(remaining - amount)}."
            )
        return text + CONFIRM_HINT

    async def _execute(self, user_id: str, action: dict, key: str) -> str:
        try:
            if action["kind"] == PAY_INVOICE:
                return await self._pay_invoice(user_id, action, key)
            return await self._settle(user_id, action, key)
        except FeatureDisabled:
            metrics.incr("action_disabled")
            return INVOICE_UNAVAILABLE if action["kind"] == PAY_INVOICE else PAYMENTS_UNAVAILABLE
        except Refused as refused:
            metrics.incr("action_refused")
            return f"Não consegui registrar: {refused.message}"

    async def _settle(self, user_id: str, action: dict, key: str) -> str:
        target = action["target"]
        income = action["type"] == "income"
        remaining = target.get("remaining") or 0
        amount = action.get("amount")
        body: dict = {"date": action["date"], "idempotencyKey": key}
        if amount is not None and abs(amount - remaining) >= TOLERANCE:
            body["amount"] = amount
        if action.get("account"):
            body["accountId"] = action["account"]["id"]
        await _post(f"/internal/users/{user_id}/transactions/{target['id']}/settlements", body)
        metrics.incr("settlement_done")

        account = (action.get("account") or {}).get("name") or target.get("accountName")
        flow = ""
        if account:
            flow = f", entrando na conta {account}" if income else f", saindo da conta {account}"
        when = _when(action["date"])
        if "amount" in body and body["amount"] < remaining:
            what = "o recebimento" if income else "o pagamento"
            return (
                f"✅ Registrei {what} de {format_brl(body['amount'])} em *{target['description']}*"
                f"{flow}, {when}. Ainda faltam {format_brl(remaining - body['amount'])}."
            )
        verb = "recebida" if income else "paga"
        return f"✅ Pronto! *{target['description']}* marcada como {verb}{flow}, {when}."

    async def _pay_invoice(self, user_id: str, action: dict, key: str) -> str:
        invoice = action["invoice"]
        amount = action.get("amount") or invoice["remaining"]
        await _post(
            f"/internal/users/{user_id}/cards/{action['card']['cardId']}"
            f"/invoices/{invoice['invoiceId']}/payments",
            {
                "sourceAccountId": action["account"]["id"],
                "amount": amount,
                "paymentDate": action["date"],
                "idempotencyKey": key,
            },
        )
        metrics.incr("invoice_payment_done")
        text = (
            f"✅ Pagamento de {format_brl(amount)} da fatura *{action['card']['name']}* "
            f"registrado, saindo da conta {action['account']['name']}, {_when(action['date'])}."
        )
        if amount < invoice["remaining"] - TOLERANCE:
            text += f" Ainda faltam {format_brl(invoice['remaining'] - amount)} nessa fatura."
        return text

    @staticmethod
    async def _named_account(user_id: str, name: str | None) -> dict | None:
        """A conta comum que a mensagem citou ("pelo Itaú"), se houver só uma assim."""
        if not name:
            return None
        regular = [r for r in await user_catalog.accounts(user_id) if not is_card(r)]
        hits = parsers.match_names(name, [r["name"] for r in regular])
        if len(hits) != 1:
            return None
        chosen = regular[hits[0]]
        return {"id": chosen["id"], "name": chosen["name"]}


action_processor = ActionProcessor()
