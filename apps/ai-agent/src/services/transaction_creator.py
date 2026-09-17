"""Cria lançamentos em apps/api a partir de um FinancialIntent confirmado (P3.6)."""

import logging
import unicodedata
from datetime import date

from ..schemas.financial_intent import FinancialIntent
from .api_client import api_client
from .clock import today_local
from .metrics import metrics

logger = logging.getLogger(__name__)


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.lower().strip()


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
        account_id = await self._resolve_account(user_id, intent.account_name)
        if account_id is None:
            return {
                "ok": False,
                "message": "Você ainda não tem uma conta cadastrada. Crie uma no app primeiro.",
            }

        category_id = await self._resolve_category(user_id, intent.category_name)

        payload = {
            "userId": user_id,
            "accountId": account_id,
            "categoryId": category_id,
            "type": intent.transaction_type.value if intent.transaction_type else "expense",
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

    async def _resolve_account(self, user_id: str, account_name: str | None) -> str | None:
        try:
            response = await api_client.get(f"/internal/users/{user_id}/accounts")
            accounts = response.json() if response.status_code == 200 else []
        except Exception:  # noqa: BLE001
            logger.exception("Erro ao listar contas do usuário %s", user_id)
            return None

        if not accounts:
            return None

        if account_name:
            target = _normalize(account_name)
            for acc in accounts:
                if _normalize(acc["name"]) == target or target in _normalize(acc["name"]):
                    return acc["id"]

        # Conta padrão: a primeira (mais antiga) conta ativa.
        return accounts[0]["id"]

    async def _resolve_category(self, user_id: str, category_name: str | None) -> str | None:
        if not category_name:
            return None
        try:
            response = await api_client.get(f"/internal/users/{user_id}/categories")
            categories = response.json() if response.status_code == 200 else []
        except Exception:  # noqa: BLE001
            logger.exception("Erro ao listar categorias do usuário %s", user_id)
            return None

        target = _normalize(category_name)
        for cat in categories:
            if _normalize(cat["name"]) == target:
                return cat["id"]
        for cat in categories:
            if target in _normalize(cat["name"]) or _normalize(cat["name"]) in target:
                return cat["id"]
        return None


transaction_creator = TransactionCreator()
