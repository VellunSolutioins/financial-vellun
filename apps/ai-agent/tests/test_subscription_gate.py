"""Testes do SubscriptionGate: libera/bloqueia e fail-closed em erro."""

import asyncio

import src.services.subscription_gate as sg


class _Resp:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


class _FakeApi:
    def __init__(self, resp=None, raises=False):
        self._resp = resp
        self._raises = raises
        self.calls: list[str] = []

    async def get(self, path):
        self.calls.append(path)
        if self._raises:
            raise RuntimeError("network down")
        return self._resp


def _evaluate(api):
    original = sg.api_client
    sg.api_client = api
    try:
        return asyncio.run(sg.subscription_gate.evaluate("u1"))
    finally:
        sg.api_client = original


def test_allows_when_can_use_product():
    api = _FakeApi(_Resp(200, {"canUseProduct": True}))
    allowed, msg = _evaluate(api)
    assert allowed is True
    assert msg is None
    assert api.calls == ["/internal/users/u1/subscription-access"]


def test_denies_when_no_access():
    allowed, msg = _evaluate(_FakeApi(_Resp(200, {"canUseProduct": False})))
    assert allowed is False
    assert msg == sg.NO_SUBSCRIPTION_MESSAGE


def test_fail_closed_on_network_error():
    allowed, msg = _evaluate(_FakeApi(raises=True))
    assert allowed is False
    assert msg == sg.UNAVAILABLE_MESSAGE


def test_fail_closed_on_unexpected_status():
    allowed, msg = _evaluate(_FakeApi(_Resp(500)))
    assert allowed is False
    assert msg == sg.UNAVAILABLE_MESSAGE
