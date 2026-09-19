"""Payload que o TransactionCreator envia para ``/internal/transactions/from-ai``."""

import asyncio

import src.services.transaction_creator as tc
from src.schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum


class _Response:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = ""

    def json(self):
        return self._body


class _FakeApi:
    def __init__(self):
        self.posted: dict | None = None

    async def get(self, path):
        if path.endswith("/accounts"):
            return _Response(200, [{"id": "acc-1", "name": "Carteira"}])
        return _Response(200, [])

    async def post(self, path, json):
        self.posted = json
        return _Response(201, {"id": "tx-1"})


def _create(monkeypatch, **kwargs) -> dict:
    api = _FakeApi()
    monkeypatch.setattr(tc, "api_client", api)
    intent = FinancialIntent(
        intent=IntentType.create_transaction,
        transaction_type=TransactionTypeEnum.expense,
        amount=12.5,
        transaction_date="2026-06-18",
        confidence=0.9,
    )
    result = asyncio.run(tc.transaction_creator.create_from_intent(intent, "dono", "gastei", **kwargs))
    assert result["ok"] is True
    assert api.posted is not None
    return api.posted


def test_sends_author_when_informed(monkeypatch):
    payload = _create(monkeypatch, created_by_user_id="membro", idempotency_key="job-1")

    assert payload["userId"] == "dono"
    assert payload["createdByUserId"] == "membro"
    assert payload["idempotencyKey"] == "job-1"


def test_omits_author_when_absent(monkeypatch):
    payload = _create(monkeypatch)

    assert "createdByUserId" not in payload
