"""Testes do ConversationHistoryService (Etapa 3)."""

import asyncio

import src.services.conversation_history_service as chs


class _FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


def _patch_get(fake):
    original = chs.api_client.get
    chs.api_client.get = fake
    return original


def test_empty_when_no_conversation():
    async def fake_get(path, **kwargs):
        return _FakeResponse(200, {"conversationId": None, "messages": []})

    original = _patch_get(fake_get)
    try:
        result = asyncio.run(
            chs.conversation_history_service.get_recent_messages("+5511", 15)
        )
    finally:
        chs.api_client.get = original

    assert result == []


def test_returns_chronological_messages():
    async def fake_get(path, **kwargs):
        return _FakeResponse(
            200,
            {
                "conversationId": "c1",
                "messages": [
                    {"direction": "inbound", "content": "gastei", "createdAt": "t1"},
                    {"direction": "outbound", "content": "qual valor?", "createdAt": "t2"},
                ],
            },
        )

    original = _patch_get(fake_get)
    try:
        result = asyncio.run(
            chs.conversation_history_service.get_recent_messages("+5511", 15)
        )
    finally:
        chs.api_client.get = original

    assert [m["content"] for m in result] == ["gastei", "qual valor?"]
    assert result[0]["direction"] == "inbound"


def test_network_error_returns_empty():
    async def fake_get(path, **kwargs):
        raise RuntimeError("rede indisponível")

    original = _patch_get(fake_get)
    try:
        result = asyncio.run(
            chs.conversation_history_service.get_recent_messages("+5511", 15)
        )
    finally:
        chs.api_client.get = original

    assert result == []
