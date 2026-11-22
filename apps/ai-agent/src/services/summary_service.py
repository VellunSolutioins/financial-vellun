"""Consultas de resumo pelo WhatsApp: "quanto gastei?", saldo, contas a pagar.

Fase 1 do plano ``docs/plans/018-agente-acoes-whatsapp.md``. Os números vêm de
``GET /internal/users/{userId}/summary``, que devolve os **mesmos do dashboard
do app** — a resposta aqui tem de bater com a tela. Este módulo só escolhe o
período, busca e escreve a resposta.

Rótulos para quem não entende de contabilidade (docs/adrs/0020): "Gastos",
"Recebido", "A pagar", "A receber". Nada de "realizado" ou "liquidação".
"""

from __future__ import annotations

import logging
from datetime import date

from ..config import settings
from ..schemas.financial_intent import FinancialIntent, SummaryFocusEnum, TransactionTypeEnum
from . import reply_parsers as parsers
from .api_client import api_client
from .confirmation_rules import format_brl
from .metrics import metrics

logger = logging.getLogger(__name__)

#: Resposta com a funcionalidade desligada no /ops (``whatsapp_summary``).
SUMMARY_UNAVAILABLE_MESSAGE = (
    "Consulta de resumo via WhatsApp ainda não está disponível. Veja no app."
)
SUMMARY_ERROR_MESSAGE = (
    "Não consegui buscar seu resumo agora. Tente de novo em instantes ou veja no app."
)

_MONTH_NAMES = (
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
)
#: Quantas categorias o resumo de gastos destaca.
TOP_CATEGORIES = 3
#: Quantas contas a pagar o resumo geral lista (a lista própria mostra todas).
OVERVIEW_BILLS = 3


class FeatureDisabled(Exception):
    """A rota respondeu ``403 FEATURE_DISABLED``: a funcionalidade está desligada."""


def _parse_iso(value: str | None) -> date | None:
    try:
        return date.fromisoformat(value[:10]) if value else None
    except ValueError:
        return None


def resolve_period(intent: FinancialIntent, today: date) -> tuple[date, date] | None:
    """Período pedido, coerente; ``None`` é o mês corrente (padrão da API).

    O LLM às vezes manda só uma das pontas: "outubro" pode vir só com o
    início. A outra ponta é o fim (ou o começo) do mesmo mês.
    """
    start = _parse_iso(intent.period_start)
    end = _parse_iso(intent.period_end)
    if start is None and end is None:
        return None
    if start is None:
        start = parsers.month_bounds(end.year, end.month)[0]  # type: ignore[union-attr]
    if end is None:
        end = parsers.month_bounds(start.year, start.month)[1]
    if start > end:
        start, end = end, start
    # "Esse mês": o LLM costuma mandar do dia 1 até hoje. O dashboard conta o
    # mês inteiro (o que vence até o fim dele entra no "a receber").
    first, last = parsers.month_bounds(start.year, start.month)
    if start == first and (end.year, end.month) == (start.year, start.month) and end >= today:
        end = last
    return start, end


def _day(iso: str) -> str:
    parsed = _parse_iso(iso)
    return parsed.strftime("%d/%m") if parsed else iso


def period_label(start_iso: str, end_iso: str, today: date) -> str:
    """"em novembro", "em outubro de 2025", "hoje", "de 16/11 a 22/11"."""
    start, end = _parse_iso(start_iso), _parse_iso(end_iso)
    if start is None or end is None:
        return ""
    if start == end:
        return "hoje" if start == today else f"em {start.strftime('%d/%m')}"
    first, last = parsers.month_bounds(start.year, start.month)
    if (start, end) == (first, last):
        month = _MONTH_NAMES[start.month - 1]
        return f"em {month}" if start.year == today.year else f"em {month} de {start.year}"
    if (start, end) == (date(start.year, 1, 1), date(start.year, 12, 31)):
        return f"em {start.year}"
    return f"de {start.strftime('%d/%m')} a {end.strftime('%d/%m')}"


def _percent(part: float, total: float) -> str:
    return f"{round(part / total * 100)}%" if total > 0 else ""


class SummaryService:
    async def fetch(self, user_id: str, period: tuple[date, date] | None) -> dict:
        """Busca o resumo. Levanta :class:`FeatureDisabled` com a flag desligada."""
        params = {}
        if period is not None:
            params = {"periodStart": period[0].isoformat(), "periodEnd": period[1].isoformat()}
        response = await api_client.get(f"/internal/users/{user_id}/summary", params=params)
        if response.status_code == 403 and _error_code(response) == "FEATURE_DISABLED":
            raise FeatureDisabled
        if response.status_code != 200:
            raise RuntimeError(f"resumo respondeu {response.status_code}")
        return response.json()

    async def answer(self, user_id: str, intent: FinancialIntent, today: date) -> str:
        """Resposta pronta para a consulta; nunca levanta."""
        try:
            summary = await self.fetch(user_id, resolve_period(intent, today))
        except FeatureDisabled:
            metrics.incr("summary_disabled")
            return SUMMARY_UNAVAILABLE_MESSAGE
        except Exception:  # noqa: BLE001 — rede ou API: responde e segue
            metrics.incr("summary_failed")
            logger.exception("Falha ao buscar resumo")
            return SUMMARY_ERROR_MESSAGE

        metrics.incr("summary_answered")
        return format_summary(summary, intent, today)


def _error_code(response) -> str | None:
    try:
        body = response.json()
    except Exception:  # noqa: BLE001
        return None
    return body.get("code") if isinstance(body, dict) else None


def focus_of(intent: FinancialIntent) -> SummaryFocusEnum:
    """Foco da consulta. Sem foco, mas com tipo ou categoria, o tipo decide."""
    if intent.summary_focus is not None:
        return intent.summary_focus
    if intent.transaction_type == TransactionTypeEnum.income:
        return SummaryFocusEnum.income
    if intent.transaction_type == TransactionTypeEnum.expense or intent.category_name:
        return SummaryFocusEnum.spending
    return SummaryFocusEnum.overview


def format_summary(summary: dict, intent: FinancialIntent, today: date) -> str:
    """Escreve a resposta conforme o que foi perguntado."""
    period = summary.get("period") or {}
    when = period_label(period.get("start", ""), period.get("end", ""), today)
    focus = focus_of(intent)

    if focus == SummaryFocusEnum.spending:
        body = _spending(summary, when, intent.category_name)
    elif focus == SummaryFocusEnum.income:
        body = _income(summary, when)
    elif focus == SummaryFocusEnum.balance:
        body = _balance(summary)
    elif focus == SummaryFocusEnum.upcoming:
        body = _upcoming(summary)
    else:
        body = _overview(summary, when)
    return f"{body}\n\n{_footer(summary)}"


def _business(summary: dict) -> bool:
    return summary.get("profileType") == "business"


def _spending(summary: dict, when: str, category_name: str | None) -> str:
    spent = summary.get("spent") or 0
    categories = summary.get("byCategory") or []
    label = "Despesas" if _business(summary) else "Gastos"

    if category_name:
        names = [c["name"] for c in categories]
        matches = parsers.match_names(category_name, names)
        if matches:
            category = categories[matches[0]]
            share = _percent(category["total"], spent)
            extra = f" ({share} do total de {format_brl(spent)})" if share else ""
            return (
                f"💸 {label} com *{category['name']}* {when}: "
                f"{format_brl(category['total'])}{extra}"
            )
        if summary.get("byCategoryComplete", True):
            return f"💸 Não encontrei {label.lower()} com *{category_name}* {when}."
        return (
            f"💸 *{category_name}* não está entre as maiores despesas {when}. "
            "O detalhe por categoria está no app."
        )

    lines = [f"💸 *{label} {when}:* {format_brl(spent)}"]
    top = categories[:TOP_CATEGORIES]
    if top:
        lines.append(
            "Maiores: " + " · ".join(f"{c['name']} {format_brl(c['total'])}" for c in top)
        )
    forecast = summary.get("spentForecast") or 0
    if forecast > 0:
        lines.append(f"Previstos, ainda não pagos: {format_brl(forecast)}")
    return "\n".join(lines)


def _income(summary: dict, when: str) -> str:
    received = summary.get("received") or 0
    to_receive = summary.get("toReceive") or 0
    if _business(summary):
        lines = [f"💰 *Receitas {when}:* {format_brl(received)}"]
        if to_receive > 0:
            lines.append(f"A receber (em aberto): {format_brl(to_receive)}")
    else:
        lines = [f"💰 *Recebido {when}:* {format_brl(received)}"]
        if to_receive > 0:
            lines.append(f"Ainda a receber {when}: {format_brl(to_receive)}")
    lines += _income_section(summary)
    return "\n".join(lines)


def _income_line(index: int, item: dict) -> str:
    when = _day(item.get("dueDate", ""))
    status = f"⚠️ atrasada, era para {when}" if item.get("isOverdue") else f"previsto para {when}"
    description = item.get("description") or "Receita"
    return f"{index}. {description} — {format_brl(item['remaining'])} — {status}"


def _income_section(summary: dict) -> list[str]:
    """Receitas previstas em aberto, as atrasadas primeiro.

    Ficam à parte das contas a pagar: receita não é conta, e antes um salário
    fixo aparecia como "conta a pagar" com vencimento.
    """
    items = summary.get("upcomingIncome") or []
    if not items:
        return []
    ordered = sorted(items, key=lambda i: (not i.get("isOverdue"), i.get("dueDate", "")))
    lines = ["", "Receitas previstas:"]
    lines += [_income_line(n, item) for n, item in enumerate(ordered[:OVERVIEW_BILLS], start=1)]
    return lines


def _result_line(summary: dict) -> str:
    result = summary.get("result") or 0
    if result >= 0:
        return f"Sobrou: {format_brl(result)}"
    return f"Gastou mais do que recebeu: {format_brl(abs(result))}"


def _balance(summary: dict) -> str:
    lines = []
    balance = summary.get("cashBalance")
    if balance is None:
        lines.append("🏦 Você ainda não tem conta cadastrada para eu mostrar o saldo.")
    else:
        lines.append(f"🏦 *Saldo nas contas hoje:* {format_brl(balance)}")

    commitments = summary.get("commitments") or {}
    until = commitments.get("until")
    to_pay = commitments.get("toPay") or 0
    overdue = commitments.get("overdue") or 0
    to_receive = commitments.get("toReceive") or 0
    prefix = f"Até {_day(until)}" if until else "Em aberto"
    pay = f"a pagar {format_brl(to_pay)}"
    if overdue > 0:
        pay += f" ({format_brl(overdue)} já vencidos)"
    lines.append(f"{prefix}: {pay} · a receber {format_brl(to_receive)}")

    cards = summary.get("cardsDebt") or 0
    if cards > 0:
        lines.append(f"Dívida nos cartões: {format_brl(cards)}")
    return "\n".join(lines)


def _bill_line(index: int, item: dict) -> str:
    due = _day(item.get("dueDate", ""))
    status = f"⚠️ venceu {due}" if item.get("isOverdue") else f"vence {due}"
    description = item.get("description") or "Conta"
    return f"{index}. {description} — {format_brl(item['remaining'])} — {status}"


def _upcoming(summary: dict) -> str:
    items = summary.get("upcoming") or []
    if not items:
        return "📅 Você não tem contas a pagar em aberto. 🎉"
    # Vencidas primeiro; dentro de cada grupo, pela data.
    ordered = sorted(items, key=lambda i: (not i.get("isOverdue"), i.get("dueDate", "")))
    lines = ["📅 *Próximas contas a pagar:*"]
    lines += [_bill_line(n, item) for n, item in enumerate(ordered, start=1)]
    commitments = summary.get("commitments") or {}
    total = commitments.get("toPay") or 0
    if total > 0:
        until = commitments.get("until")
        scope = f"até {_day(until)}" if until else "em aberto"
        lines.append(f"Total {scope}: {format_brl(total)}")
    return "\n".join(lines)


def _overview(summary: dict, when: str) -> str:
    business = _business(summary)
    lines = [f"📊 *Resumo {when}*"]
    spent_label = "Despesas" if business else "Gastos"
    received_label = "Receitas" if business else "Recebido"
    lines.append(f"{spent_label}: {format_brl(summary.get('spent') or 0)}")
    lines.append(f"{received_label}: {format_brl(summary.get('received') or 0)}")
    lines.append(_result_line(summary))
    balance = summary.get("cashBalance")
    if balance is not None:
        lines.append(f"Saldo nas contas hoje: {format_brl(balance)}")

    items = summary.get("upcoming") or []
    if items:
        ordered = sorted(items, key=lambda i: (not i.get("isOverdue"), i.get("dueDate", "")))
        lines.append("")
        lines.append("Próximas contas:")
        lines += [_bill_line(n, item) for n, item in enumerate(ordered[:OVERVIEW_BILLS], start=1)]
    lines += _income_section(summary)
    return "\n".join(lines)


def _footer(summary: dict) -> str:
    area = "empresa" if _business(summary) else "pessoal"
    return f"Detalhes no app: {settings.web_url}/app/{area}/dashboard"


summary_service = SummaryService()
