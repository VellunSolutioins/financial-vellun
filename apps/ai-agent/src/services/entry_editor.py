"""Corrigir e excluir um lançamento já gravado pelo WhatsApp.

Fase 3 do plano ``docs/plans/018-agente-acoes-whatsapp.md`` (ADR 0024).
Alcance: "o último" registrado pelo WhatsApp, ou um dos lançamentos dos
últimos 30 dias, encontrado pelo nome, valor ou data ditos. Com mais de um
candidato, lista numerada. Toda mudança **mostra o antes e o depois e espera
um "sim"**.

O estado entre as mensagens fica em ``ConversationState.pending_action``, como
na Fase 2 (ver :mod:`action_processor`):

- ``kind``: ``edit`` ou ``delete``;
- ``step``: ``choose`` (lista), ``changes`` (perguntou o que mudar) ou
  ``confirm`` (sim/não);
- ``pick``: o que a lista escolhe — ``target``, ``category`` ou ``account``;
- ``target``: o lançamento, como ``GET recent-entries`` o devolve;
- ``changes``: o que o usuário pediu (nomes) e o que já foi resolvido (ids);
- ``reference``: o dia da mensagem, base de "ontem".

As regras financeiras ficam na API (fatura fechada, estorno, parcela).
"""

from __future__ import annotations

import logging
from datetime import date

from ..messaging.base import TransientError
from ..schemas.financial_intent import EntryChanges, FinancialIntent, IntentType, TargetRef
from . import reply_parsers as parsers
from .action_processor import (
    CONFIRM_HINT,
    MAX_OPTIONS,
    NOTHING_DONE,
    TOLERANCE,
    ActionOutcome,
    FeatureDisabled,
    Refused,
    _api_message,
    _day,
    _disabled,
    _list_question,
    unparsed_reply,
)
from .api_client import api_client
from .clock import today_local
from .confirmation_rules import format_brl
from .conversation_manager import conversation_manager
from .metrics import metrics
from .target_resolver import (
    EDIT_STOPWORDS,
    label_matches,
    last_from_whatsapp,
    rank_recent,
    subject_tokens,
)
from .transaction_creator import _split_account_name, is_card
from .user_catalog import user_catalog

logger = logging.getLogger(__name__)

EDIT = "edit"
DELETE = "delete"
#: Os ``kind`` de ``pending_action`` que este módulo responde.
KINDS = frozenset({EDIT, DELETE})
STEP_CHOOSE = "choose"
STEP_CHANGES = "changes"
STEP_CONFIRM = "confirm"
PICK_TARGET = "target"
PICK_CATEGORY = "category"
PICK_ACCOUNT = "account"

EDIT_UNAVAILABLE = "Para corrigir ou cancelar um lançamento, use o app por enquanto."
API_ERROR = "Não consegui consultar seus lançamentos agora. Tente de novo em instantes."
NO_LAST = (
    "Não encontrei lançamento feito por aqui nos últimos 30 dias. Me diga qual é, "
    "por exemplo: \"apaga o mercado de ontem\"."
)
INSTALLMENT_EDIT = (
    "Compra parcelada se altera no app, em Parcelamentos. Por aqui dá para excluir a "
    "compra inteira."
)
CHANGES_HINT = (
    "Por exemplo: \"o valor é 45\", \"a data é ontem\", \"a categoria é Lazer\" ou "
    "\"a conta é Nubank\"."
)


# ── Chamadas à API ───────────────────────────────────────────────────────────
async def _recent(user_id: str) -> list[dict]:
    response = await api_client.get(f"/internal/users/{user_id}/recent-entries")
    if _disabled(response):
        raise FeatureDisabled
    if response.status_code != 200:
        raise RuntimeError(f"recent-entries respondeu {response.status_code}")
    return response.json().get("entries") or []


class Gone(Exception):
    """O lançamento não existe mais (404)."""


async def _send(method: str, path: str, body: dict | None = None) -> dict:
    """PATCH/DELETE de uma ação. Falha de transporte ou 5xx: ``TransientError``
    (o job é retentado; repetir a correção dá no mesmo, e repetir a exclusão
    responde 404 — "já tinha sido excluído")."""
    try:
        if method == "PATCH":
            response = await api_client.patch(path, json=body)
        else:
            response = await api_client.delete(path)
    except Exception as exc:  # noqa: BLE001
        raise TransientError(f"API indisponível ao executar ação: {type(exc).__name__}") from exc
    if response.status_code in (200, 201):
        try:
            return response.json()
        except Exception:  # noqa: BLE001
            return {}
    if _disabled(response):
        raise FeatureDisabled
    if response.status_code == 404:
        raise Gone
    if response.status_code in (400, 409):
        raise Refused(_api_message(response))
    raise TransientError(f"ação respondeu {response.status_code}")


# ── Textos ───────────────────────────────────────────────────────────────────
def _is_installment(entry: dict) -> bool:
    return entry.get("recurrenceType") == "parcelado" and bool(entry.get("seriesId"))


def _is_fixed(entry: dict) -> bool:
    return entry.get("recurrenceType") == "fixo"


def _value(entry: dict) -> str:
    if _is_installment(entry):
        return f"{entry.get('installmentTotal') or '?'}x de {format_brl(entry['amount'])}"
    return format_brl(entry["amount"])


def _entry_label(entry: dict) -> str:
    """"Mercado — R$ 50,00 — 17/11 (Nubank)", para a lista e a confirmação."""
    fixed = ", fixo" if _is_fixed(entry) else ""
    where = f" ({entry['accountName']})" if entry.get("accountName") else ""
    return f"{entry['description']} — {_value(entry)} — {_day(entry.get('date'))}{fixed}{where}"


def _money_note(entry: dict) -> str:
    """Excluir um lançamento pago à vista desfaz o pagamento: o saldo volta."""
    if entry.get("onCard") or (entry.get("settledAmount") or 0) <= 0:
        return ""
    account = entry.get("accountName") or "conta"
    if entry.get("type") == "income":
        return f" O valor sai do saldo da conta {account}."
    return f" O valor volta para o saldo da conta {account}."


def _reference(action: dict) -> date:
    try:
        return date.fromisoformat(action.get("reference") or "")
    except ValueError:
        return today_local()


class EntryEditor:
    # ── Início ──────────────────────────────────────────────────────────────
    async def start(
        self,
        phone: str,
        contact: dict | None,
        user_id: str,
        intent: FinancialIntent,
        reference: date,
        raw_message: str,
    ) -> ActionOutcome:
        """"Apaga o último", "corrige o mercado de ontem, foi 45"."""
        kind = DELETE if intent.intent == IntentType.cancel_last else EDIT
        metrics.incr("intent_delete_entry" if kind == DELETE else "intent_edit_entry")
        try:
            entries = await _recent(user_id)
        except FeatureDisabled:
            metrics.incr("action_disabled")
            return ActionOutcome(text=EDIT_UNAVAILABLE)
        except Exception:  # noqa: BLE001
            metrics.incr("action_api_failed")
            logger.exception("Falha ao buscar lançamentos recentes")
            return ActionOutcome(text=API_ERROR)

        target = intent.target or TargetRef()
        words = subject_tokens(target.description, extra=EDIT_STOPWORDS)
        on = (target.date or "")[:10] or None
        named = bool(words or target.amount is not None or on)
        # O que foi dito vale mais que ``last``: o LLM marca "o último" até em
        # "exclui o mercado de ontem".
        if not named:
            last = last_from_whatsapp(entries)
            candidates = [last] if last else []
            if not candidates:
                return ActionOutcome(text=NO_LAST)
        else:
            candidates = rank_recent(entries, words=words, amount=target.amount, on=on)
            if not candidates:
                subject = " ".join(words) or "esse lançamento"
                return ActionOutcome(
                    text=(
                        f"Não encontrei *{subject}* nos últimos 30 dias. Para lançamentos "
                        "mais antigos, use o app."
                    )
                )

        changes = (intent.changes or EntryChanges()).model_dump()
        action = {"kind": kind, "changes": changes, "reference": reference.isoformat()}
        if len(candidates) == 1:
            return await self._with_target(phone, contact, user_id, action, candidates[0])
        options = candidates[:MAX_OPTIONS]
        action.update(step=STEP_CHOOSE, pick=PICK_TARGET, options=options)
        await conversation_manager.set_action(phone, action, contact)
        verb = "excluir" if kind == DELETE else "corrigir"
        return ActionOutcome(
            text=_list_question(
                f"Qual destes você quer {verb}?", [_entry_label(o) for o in options]
            )
        )

    async def _with_target(
        self, phone: str, contact: dict | None, user_id: str, action: dict, entry: dict
    ) -> ActionOutcome:
        action["target"] = entry
        if action["kind"] == DELETE:
            return await self._ask_confirm(phone, contact, action)
        if _is_installment(entry):
            await conversation_manager.clear(phone)
            return ActionOutcome(text=INSTALLMENT_EDIT)
        if not self._has_changes(action["changes"]):
            action["step"] = STEP_CHANGES
            await conversation_manager.set_action(phone, action, contact)
            return ActionOutcome(
                text=f"O que devo mudar em *{_entry_label(entry)}*? {CHANGES_HINT}"
            )
        return await self._resolve_and_confirm(phone, contact, user_id, action)

    @staticmethod
    def _has_changes(changes: dict) -> bool:
        return any(
            changes.get(field) not in (None, "")
            for field in (
                "amount",
                "transaction_date",
                "category_name",
                "category_id",
                "account_name",
                "account_id",
                "description",
            )
        )

    # ── Mudanças ────────────────────────────────────────────────────────────
    async def _resolve_and_confirm(
        self, phone: str, contact: dict | None, user_id: str, action: dict
    ) -> ActionOutcome:
        """Troca nomes de categoria e conta por ids (perguntando na dúvida) e
        mostra o antes e o depois."""
        entry = action["target"]
        changes = action["changes"]

        if changes.get("category_name") and not changes.get("category_id"):
            categories = [
                c
                for c in await user_catalog.categories(user_id)
                if c.get("type") in (None, entry.get("type"))
            ]
            names = [c["name"] for c in categories]
            hits = parsers.match_names(changes["category_name"], names)
            if len(hits) == 1:
                chosen = categories[hits[0]]
                changes.update(category_id=chosen["id"], category_label=chosen["name"])
            else:
                options = [categories[i] for i in hits] or categories
                if not options:
                    changes["category_name"] = None
                else:
                    shown = [{"id": c["id"], "name": c["name"]} for c in options[:MAX_OPTIONS * 2]]
                    action.update(step=STEP_CHOOSE, pick=PICK_CATEGORY, options=shown)
                    await conversation_manager.set_action(phone, action, contact)
                    title = (
                        f"Não encontrei a categoria \"{changes['category_name']}\". Qual destas?"
                        if not hits
                        else "Qual destas categorias?"
                    )
                    return ActionOutcome(
                        text=_list_question(title, [o["name"] for o in shown])
                    )

        if changes.get("account_name") and not changes.get("account_id"):
            name, card_suffix = _split_account_name(changes["account_name"])
            resources = [
                r
                for r in await user_catalog.accounts(user_id)
                if not (entry.get("type") == "income" and is_card(r))
                and (not card_suffix or is_card(r))
            ]
            hits = parsers.match_names(name, [r["name"] for r in resources])
            if len(hits) == 1:
                chosen = resources[hits[0]]
                changes.update(account_id=chosen["id"], account_label=_resource_label(chosen))
            elif hits:
                shown = [
                    {"id": resources[i]["id"], "name": _resource_label(resources[i])}
                    for i in hits[:MAX_OPTIONS]
                ]
                action.update(step=STEP_CHOOSE, pick=PICK_ACCOUNT, options=shown)
                await conversation_manager.set_action(phone, action, contact)
                return ActionOutcome(
                    text=_list_question("Qual destas contas?", [o["name"] for o in shown])
                )
            else:
                await conversation_manager.clear(phone)
                return ActionOutcome(
                    text=(
                        f"Não encontrei a conta *{name}*. Mande de novo com o nome como "
                        "aparece no app."
                    )
                )

        body, lines = self._diff(entry, changes)
        if not body:
            await conversation_manager.clear(phone)
            return ActionOutcome(
                text=f"Já está assim: *{_entry_label(entry)}*. Não mudei nada."
            )
        action["body"] = body
        action["lines"] = lines
        return await self._ask_confirm(phone, contact, action)

    @staticmethod
    def _diff(entry: dict, changes: dict) -> tuple[dict, list[str]]:
        """O corpo do PATCH e as linhas "antes → depois" da confirmação."""
        body: dict = {}
        lines: list[str] = []
        amount = changes.get("amount")
        if amount is not None and amount > 0 and abs(amount - entry["amount"]) >= TOLERANCE:
            body["amount"] = round(amount, 2)
            lines.append(f"Valor: {format_brl(entry['amount'])} → {format_brl(amount)}")
        new_date = (changes.get("transaction_date") or "")[:10]
        if new_date and new_date != entry.get("date"):
            try:
                date.fromisoformat(new_date)
            except ValueError:
                new_date = ""
            if new_date:
                body["transactionDate"] = new_date
                lines.append(f"Data: {_day(entry.get('date'))} → {_day(new_date)}")
        category_id = changes.get("category_id")
        if category_id and category_id != entry.get("categoryId"):
            body["categoryId"] = category_id
            before = entry.get("categoryName") or "sem categoria"
            lines.append(f"Categoria: {before} → {changes.get('category_label')}")
        account_id = changes.get("account_id")
        if account_id and account_id != entry.get("accountId"):
            body["accountId"] = account_id
            lines.append(f"Conta: {entry.get('accountName')} → {changes.get('account_label')}")
        description = (changes.get("description") or "").strip()
        if description and description != entry.get("description"):
            body["description"] = description[:255]
            lines.append(f"Nome: {entry.get('description')} → {description}")
        return body, lines

    # ── Resposta às perguntas ───────────────────────────────────────────────
    async def handle_reply(
        self,
        phone: str,
        contact: dict | None,
        state,
        reply: str,
        idempotency_key: str | None,
    ) -> ActionOutcome:
        action = dict(state.pending_action or {})
        user_id = state.user_id
        step = action.get("step")

        if parsers.is_negative(reply) and not (
            step == STEP_CHANGES and parsers.parse_amount(reply) is not None
        ):
            await conversation_manager.clear(phone)
            metrics.incr("action_cancelled")
            return ActionOutcome(text=NOTHING_DONE)

        if step == STEP_CONFIRM:
            if parsers.is_affirmative(reply):
                text = await self._execute(user_id, action)
                await conversation_manager.clear(phone)
                return ActionOutcome(text=text)
            return await unparsed_reply(
                phone, contact, state, action, reply, self._confirm_text(action)
            )

        if step == STEP_CHANGES:
            parsed = await self._parse_changes(user_id, action, reply)
            if parsed is None:
                return await unparsed_reply(
                    phone, contact, state, action, reply, f"O que devo mudar? {CHANGES_HINT}"
                )
            action["changes"] = {**action["changes"], **parsed}
            action.pop("step", None)
            return await self._resolve_and_confirm(phone, contact, user_id, action)

        options = action.get("options") or []
        index = self._pick(reply, options)
        if index is None:
            retry = f"Responda com o número da lista (1 a {len(options)}) ou *não* para cancelar."
            return await unparsed_reply(phone, contact, state, action, reply, retry)
        chosen = options[index]
        action.pop("options", None)
        pick = action.pop("pick", None)
        action.pop("step", None)
        if pick == PICK_TARGET:
            return await self._with_target(phone, contact, user_id, action, chosen)
        if pick == PICK_CATEGORY:
            action["changes"].update(category_id=chosen["id"], category_label=chosen["name"])
        else:
            action["changes"].update(account_id=chosen["id"], account_label=chosen["name"])
        return await self._resolve_and_confirm(phone, contact, user_id, action)

    @staticmethod
    def _pick(reply: str, options: list[dict]) -> int | None:
        number = parsers.parse_int(reply)
        if number is not None and 1 <= number <= len(options):
            return number - 1
        labels = [o.get("description") or o.get("name") or "" for o in options]
        hits = label_matches(reply, labels)
        return hits[0] if len(hits) == 1 else None

    async def _parse_changes(self, user_id: str, action: dict, reply: str) -> dict | None:
        """A resposta a "o que devo mudar?": valor, data, categoria ou conta,
        pelas regras (sem LLM). ``None`` se nada for reconhecido."""
        entry = action["target"]
        parsed: dict = {}
        on = parsers.parse_date(reply, _reference(action))
        if on is not None:
            parsed["transaction_date"] = on.isoformat()
        amount = parsers.parse_amount(reply)
        if amount is not None:
            parsed["amount"] = amount
        categories = [
            c
            for c in await user_catalog.categories(user_id)
            if c.get("type") in (None, entry.get("type"))
        ]
        hits = label_matches(reply, [c["name"] for c in categories]) if categories else []
        if len(hits) == 1:
            parsed["category_name"] = categories[hits[0]]["name"]
        if "category_name" not in parsed:
            resources = await user_catalog.accounts(user_id)
            names = [r["name"] for r in resources]
            account_hits = label_matches(reply, names) if names else []
            if len(account_hits) == 1:
                parsed["account_name"] = names[account_hits[0]]
        return parsed or None

    # ── Confirmação e execução ──────────────────────────────────────────────
    async def _ask_confirm(self, phone: str, contact: dict | None, action: dict) -> ActionOutcome:
        action["step"] = STEP_CONFIRM
        await conversation_manager.set_action(phone, action, contact)
        return ActionOutcome(text=self._confirm_text(action))

    @staticmethod
    def _confirm_text(action: dict) -> str:
        entry = action["target"]
        if action["kind"] == DELETE:
            if _is_installment(entry):
                return (
                    f"Isso exclui a compra inteira: *{entry['description']}* em {_value(entry)}"
                    f" ({entry.get('accountName')}), com todas as parcelas.{_money_note(entry)}"
                    f" Confirma?{CONFIRM_HINT}"
                )
            if _is_fixed(entry):
                return (
                    f"Excluir só a de {_day(entry.get('date'))} de *{entry['description']} — "
                    f"{format_brl(entry['amount'])}*? As próximas continuam; para encerrar o "
                    f"fixo, use o app.{_money_note(entry)}{CONFIRM_HINT}"
                )
            return f"Excluir *{_entry_label(entry)}*?{_money_note(entry)}{CONFIRM_HINT}"

        lines = "\n".join(f"• {line}" for line in action.get("lines") or [])
        text = f"Corrigir *{_entry_label(entry)}*?\n{lines}"
        if _is_fixed(entry):
            text += "\nSó esta ocorrência muda; as próximas continuam como estão."
        return text + CONFIRM_HINT

    async def _execute(self, user_id: str, action: dict) -> str:
        entry = action["target"]
        try:
            if action["kind"] == DELETE:
                return await self._delete(user_id, entry)
            return await self._edit(user_id, action)
        except FeatureDisabled:
            metrics.incr("action_disabled")
            return EDIT_UNAVAILABLE
        except Gone:
            metrics.incr("action_target_gone")
            if action["kind"] == DELETE:
                return f"*{entry['description']}* já tinha sido excluído."
            return f"Não encontrei mais *{entry['description']}*; talvez tenha sido excluído."
        except Refused as refused:
            metrics.incr("action_refused")
            verb = "excluir" if action["kind"] == DELETE else "corrigir"
            return f"Não consegui {verb}: {refused.message}"

    async def _delete(self, user_id: str, entry: dict) -> str:
        if _is_installment(entry):
            result = await _send(
                "DELETE", f"/internal/users/{user_id}/installments/{entry['seriesId']}"
            )
            metrics.incr("entry_deleted")
            count = result.get("deleted") or entry.get("installmentTotal")
            return f"✅ Excluí a compra *{entry['description']}* ({count} parcelas)."
        await _send("DELETE", f"/internal/users/{user_id}/transactions/{entry['id']}")
        metrics.incr("entry_deleted")
        return f"✅ Excluí *{_entry_label(entry)}*."

    async def _edit(self, user_id: str, action: dict) -> str:
        entry = action["target"]
        updated = await _send(
            "PATCH", f"/internal/users/{user_id}/transactions/{entry['id']}", action["body"]
        )
        metrics.incr("entry_edited")
        shown = {**entry, **{k: v for k, v in updated.items() if v is not None}}
        return f"✅ Pronto! Agora está assim: *{_entry_label(shown)}*."


def _resource_label(resource: dict) -> str:
    return f"{resource['name']} (cartão)" if is_card(resource) else resource["name"]


entry_editor = EntryEditor()
