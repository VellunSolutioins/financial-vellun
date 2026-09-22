"""Limites de tamanho antes da alocação (plano de segurança, S2).

O webhook carregava o corpo inteiro antes de conferir a assinatura, e o
download de mídia materializava o arquivo inteiro antes de comparar com o
limite. Os dois agora param ao atingir o limite.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from src.config import settings
from src.main import app
from src.services.whatsapp_media import WhatsappMediaClient

MEDIA_URL = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1"


# ── Webhook ──────────────────────────────────────────────────────────────────
@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_corpo_acima_do_limite_responde_413_sem_publicar(client, broker, monkeypatch):
    monkeypatch.setattr(settings, "webhook_max_body_bytes", 64)

    response = client.post(
        "/webhook/whatsapp",
        content=b"x" * 65,
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 413
    assert broker.published["inbound"] == []


def test_corpo_chunked_acima_do_limite_tambem_e_recusado(client, broker, monkeypatch):
    monkeypatch.setattr(settings, "webhook_max_body_bytes", 64)

    def pedacos():
        for _ in range(10):
            yield b"x" * 16

    response = client.post(
        "/webhook/whatsapp",
        content=pedacos(),
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 413
    assert broker.published["inbound"] == []


def test_corpo_dentro_do_limite_segue_normalmente(client, broker):
    response = client.post(
        "/webhook/whatsapp",
        json={"phone": "+5541999999999", "message": "gastei 10", "message_id": "wamid.lim"},
    )

    assert response.status_code == 202


# ── Mídia ────────────────────────────────────────────────────────────────────
def media_client(monkeypatch, handler, max_bytes=100) -> WhatsappMediaClient:
    monkeypatch.setattr(settings, "whatsapp_provider_token", "token-de-teste")
    monkeypatch.setattr(settings, "whatsapp_api_base_url", "https://graph.facebook.com/v18.0")
    monkeypatch.setattr(settings, "media_max_bytes", max_bytes)
    media = WhatsappMediaClient()
    media._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return media


def meta_response(url=MEDIA_URL):
    return httpx.Response(200, json={"url": url, "mime_type": "audio/ogg"})


async def test_baixa_midia_dentro_do_limite(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer token-de-teste"
        if request.url.host == "graph.facebook.com":
            return meta_response()
        return httpx.Response(200, content=b"a" * 50)

    media = media_client(monkeypatch, handler)

    assert await media.fetch("m1") == (b"a" * 50, "audio/ogg")


async def test_content_length_acima_do_limite_nem_e_lido(monkeypatch):
    lidos = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "graph.facebook.com":
            return meta_response()

        async def corpo():
            lidos.append(1)
            yield b"a" * 500

        return httpx.Response(200, headers={"content-length": "500"}, content=corpo())

    media = media_client(monkeypatch, handler)

    assert await media.fetch("m1") is None
    assert lidos == []


async def test_stream_sem_tamanho_para_ao_passar_do_limite(monkeypatch):
    entregues = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "graph.facebook.com":
            return meta_response()

        async def corpo():
            for _ in range(100):
                entregues.append(1)
                yield b"a" * 40

        return httpx.Response(200, content=corpo())

    media = media_client(monkeypatch, handler)

    assert await media.fetch("m1") is None
    # Parou no terceiro pedaço (120 bytes > 100), sem consumir o resto.
    assert len(entregues) == 3


async def test_url_fora_da_meta_nao_e_baixada(monkeypatch):
    pedidos = []

    def handler(request: httpx.Request) -> httpx.Response:
        pedidos.append(request.url.host)
        return meta_response(url="http://169.254.169.254/latest/meta-data")

    media = media_client(monkeypatch, handler)

    assert await media.fetch("m1") is None
    assert pedidos == ["graph.facebook.com"]


async def test_redirecionamento_para_fora_da_meta_e_recusado(monkeypatch):
    pedidos = []

    def handler(request: httpx.Request) -> httpx.Response:
        pedidos.append(request.url.host)
        if request.url.host == "graph.facebook.com":
            return meta_response()
        return httpx.Response(302, headers={"location": "https://evil.example/arquivo"})

    media = media_client(monkeypatch, handler)

    assert await media.fetch("m1") is None
    assert "evil.example" not in pedidos
