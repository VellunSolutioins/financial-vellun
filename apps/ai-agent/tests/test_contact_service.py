"""Busca de contato: "não vinculado" e "não consegui perguntar" são coisas distintas.

Antes as duas devolviam ``None``, e um usuário vinculado recebia "seu número não
está vinculado" durante uma queda da API — em vez de a mensagem ser retentada.
"""

from __future__ import annotations

import httpx
import pytest

from src.messaging.base import TransientError
from src.services import contact_service as module
from src.services.contact_service import ContactService


class FakeApi:
    def __init__(self, resposta: httpx.Response | None = None, erro: Exception | None = None):
        self.resposta = resposta
        self.erro = erro

    async def get(self, path, **kwargs):
        if self.erro is not None:
            raise self.erro
        return self.resposta


@pytest.fixture
def api(monkeypatch):
    fake = FakeApi()
    monkeypatch.setattr(module, "api_client", fake)
    return fake


async def test_contato_vinculado(api):
    api.resposta = httpx.Response(200, json={"userId": "u1"})

    assert await ContactService().find_by_phone("+5541999999999") == {"userId": "u1"}


async def test_numero_nao_vinculado_devolve_none(api):
    api.resposta = httpx.Response(404)

    assert await ContactService().find_by_phone("+5541999999999") is None


@pytest.mark.parametrize("status", [401, 500, 503])
async def test_resposta_inesperada_e_transitoria(api, status):
    # 401 é `INTERNAL_API_KEY` divergente entre API e agente: retentar e cair na
    # DLQ com o status no erro diz isso ao operador; responder "não vinculado" não.
    api.resposta = httpx.Response(status)

    with pytest.raises(TransientError, match=str(status)):
        await ContactService().find_by_phone("+5541999999999")


async def test_api_inalcancavel_e_transitoria(api):
    api.erro = httpx.ConnectError("sem rota")

    with pytest.raises(TransientError, match="ConnectError"):
        await ContactService().find_by_phone("+5541999999999")
