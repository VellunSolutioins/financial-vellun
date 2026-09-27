"""Cria lançamentos em apps/api a partir de um FinancialIntent confirmado (P3.6)."""

import logging
import unicodedata
from datetime import date

from ..schemas.financial_intent import FinancialIntent
from .api_client import api_client
from .clock import today_local
from .metrics import metrics
from .user_catalog import user_catalog

logger = logging.getLogger(__name__)


#: Sufixo com que os cartões aparecem na lista de contas do prompt. O LLM às
#: vezes o devolve junto do nome; o resolvedor o ignora.
CARD_SUFFIX = " (cartão de crédito)"


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.lower().strip()


def is_card(resource: dict) -> bool:
    """A API marca cada item com ``kind``; sem ele (API antiga), é conta comum."""
    return resource.get("kind") == "card"


def display_name(resource: dict) -> str:
    """Nome como aparece no prompt: cartões levam o sufixo que os identifica."""
    return f"{resource['name']}{CARD_SUFFIX}" if is_card(resource) else resource["name"]


def _format_brl(value: float) -> str:
    return f"R$ {value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _format_date(iso: str) -> str:
    try:
        return date.fromisoformat(iso).strftime("%d/%m/%Y")
    except ValueError:
        return iso


class TransactionCreator:
    async def create_from_intent(
        self,
        intent: FinancialIntent,
        user_id: str,
        raw_message: str,
        ai_extracted_transaction_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict:
        """Retorna ``{ok: bool, message: str, transaction?: dict}``.

        ``idempotency_key`` (o ``jobId``) impede que um retry — inclusive um
        timeout ocorrido *depois* de o lancamento ter sido criado — gere um
        segundo lancamento: a API devolve o existente.
        """
        tx_type = intent.transaction_type.value if intent.transaction_type else "expense"
        account_id = await self._resolve_account(user_id, intent.account_name, tx_type)
        if account_id is None:
            return {
                "ok": False,
                "message": (
                    "Não encontrei uma conta para registrar. Cadastre uma conta no app "
                    "ou diga em qual cartão foi a compra."
                ),
            }

        category_id = await self._resolve_category(user_id, intent.category_name)

        payload = {
            "userId": user_id,
            "accountId": account_id,
            "categoryId": category_id,
            "type": tx_type,
            "amount": intent.amount,
            "description": intent.description or raw_message,
            "transactionDate": intent.transaction_date or today_local().isoformat(),
            "status": "confirmed",
            "source": "whatsapp",
            "rawInput": raw_message,
        }
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

        type_label = "Despesa" if payload["type"] == "expense" else "Receita"
        category_label = intent.category_name or "Sem categoria"
        message = (
            f"Lançamento criado! {type_label} de {_format_brl(intent.amount or 0)} "
            f"em {category_label} em {_format_date(payload['transactionDate'])}."
        )
        return {"ok": True, "message": message, "transaction": transaction}

    async def _resolve_account(
        self, user_id: str, account_name: str | None, tx_type: str = "expense"
    ) -> str | None:
        """``accountId`` do lançamento: conta comum ou conta interna de um cartão.

        O nome citado casa com contas e cartões (exato antes de parcial). Sem
        nome, ou sem casar, vale a primeira conta **comum** — uma compra só vai
        para o cartão quando o usuário o menciona. Receita nunca vai para cartão
        (a API recusa: devolução de compra é estorno, feito no app).
        """
        # Mesma lista que o contexto do LLM já carregou neste job; dentro do
        # escopo de memo isto não gera chamada nova.
        resources = await user_catalog.accounts(user_id)
        if tx_type == "income":
            resources = [r for r in resources if not is_card(r)]

        if account_name:
            target = _normalize(account_name)
            suffix = _normalize(CARD_SUFFIX)
            if target.endswith(suffix):
                target = target[: -len(suffix)].strip()
            for match in (
                lambda name: name == target,
                lambda name: target in name or (len(name) >= 3 and name in target),
            ):
                for resource in resources:
                    if match(_normalize(resource["name"])):
                        return resource["id"]

        # Padrão: a primeira (mais antiga) conta comum ativa.
        for resource in resources:
            if not is_card(resource):
                return resource["id"]
        return None

    async def _resolve_category(self, user_id: str, category_name: str | None) -> str | None:
        if not category_name:
            return None
        categories = await user_catalog.categories(user_id)

        target = _normalize(category_name)
        for cat in categories:
            if _normalize(cat["name"]) == target:
                return cat["id"]
        for cat in categories:
            if target in _normalize(cat["name"]) or _normalize(cat["name"]) in target:
                return cat["id"]
        return None


transaction_creator = TransactionCreator()
