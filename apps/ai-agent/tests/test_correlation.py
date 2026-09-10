"""Correlação atravessando os dois serviços.

Critério de aceite da instrumentação: um request com ``x-correlation-id`` aparece
nos logs da API **e** do agente com o mesmo id. Antes, o agente gerava o seu
próprio no webhook e ignorava o do chamador — dois ids para um fluxo, que é o
mesmo que nenhum.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from src.observability.logging import (
    CORRELATION_HEADER,
    correlation_headers,
    current_context,
    log_context,
    sanitize_correlation_id,
)


# ── Normalização do id recebido ──────────────────────────────────────────────
def test_aceita_id_seguro_vindo_de_fora():
    assert sanitize_correlation_id("abc-123_XY.7:8") == "abc-123_XY.7:8"


def test_recusa_quebra_de_linha_que_injetaria_log_falso():
    gerado = sanitize_correlation_id("ok\ninjetado")

    assert "\n" not in gerado
    assert len(gerado) == 36  # uuid4


@pytest.mark.parametrize("entrada", [None, "", "   ", "com espaco", "x" * 200, "tab\there"])
def test_gera_id_quando_a_entrada_nao_serve(entrada):
    gerado = sanitize_correlation_id(entrada)

    assert len(gerado) == 36


# ── Propagação de saída ──────────────────────────────────────────────────────
def test_propaga_o_id_do_contexto_na_chamada_de_saida():
    with log_context(correlation_id="corr-1"):
        assert correlation_headers() == {CORRELATION_HEADER: "corr-1"}


def test_nao_inventa_id_fora_de_contexto():
    # Um id criado só na chamada de saída não correlaciona com nada.
    assert correlation_headers() == {}


# ── Middleware ───────────────────────────────────────────────────────────────
@pytest.fixture
def client():
    from src.main import app

    with TestClient(app) as test_client:
        yield test_client


def test_middleware_ecoa_o_id_recebido(client):
    resposta = client.get("/health/live", headers={CORRELATION_HEADER: "corr-da-api"})

    assert resposta.headers[CORRELATION_HEADER] == "corr-da-api"


def test_middleware_gera_id_quando_nao_vem(client):
    # O webhook da Meta não envia o header; gerar é o certo aí.
    resposta = client.get("/health/live")

    assert len(resposta.headers[CORRELATION_HEADER]) == 36


def test_middleware_recusa_id_malicioso(client):
    resposta = client.get("/health/live", headers={CORRELATION_HEADER: "a b c"})

    assert resposta.headers[CORRELATION_HEADER] != "a b c"


def test_webhook_reaproveita_a_correlacao_recebida(client, monkeypatch):
    """O id do chamador chega até a mensagem publicada na fila.

    É o que permite ver, com uma consulta só, o request que entrou e o
    lançamento que saiu.
    """
    from src.bootstrap import pipeline
    from src.messaging.contracts import InboundMessageV1

    publicadas: list[InboundMessageV1] = []

    class FakePublisher:
        async def publish_many(self, routing_key, messages, *, correlation_id=None, **kwargs):
            publicadas.extend(messages)

    monkeypatch.setattr(pipeline, "publisher", FakePublisher())

    resposta = client.post(
        "/webhook/whatsapp",
        json={"phone": "+5541999999999", "message": "gastei 10", "message_id": "wamid.corr"},
        headers={CORRELATION_HEADER: "corr-ponta-a-ponta"},
    )

    assert resposta.status_code == 202
    assert publicadas
    assert publicadas[0].correlation_id == "corr-ponta-a-ponta"


def test_api_client_propaga_a_correlacao_do_contexto(monkeypatch):
    """O agente devolve para a API o mesmo id sob o qual está processando.

    Sem isso, a linha de `POST /internal/ai-events` no log da API teria um id
    próprio e não se ligaria à mensagem que a originou.
    """
    from src.services.api_client import ApiClient

    capturados: dict = {}

    class FakeAsyncClient:
        is_closed = False

        async def post(self, path, **kwargs):
            capturados.update(kwargs.get("headers") or {})
            return None

    client = ApiClient()
    monkeypatch.setattr(client, "_ensure", lambda: FakeAsyncClient())

    async def executar():
        with log_context(correlation_id="corr-do-job"):
            await client.post("/internal/ai-events", json={})

    import asyncio

    asyncio.run(executar())

    assert capturados[CORRELATION_HEADER] == "corr-do-job"


def test_api_client_nao_sobrescreve_header_explicito(monkeypatch):
    from src.services.api_client import ApiClient

    capturados: dict = {}

    class FakeAsyncClient:
        is_closed = False

        async def post(self, path, **kwargs):
            capturados.update(kwargs.get("headers") or {})
            return None

    client = ApiClient()
    monkeypatch.setattr(client, "_ensure", lambda: FakeAsyncClient())

    async def executar():
        with log_context(correlation_id="do-contexto"):
            await client.post(
                "/x", json={}, headers={CORRELATION_HEADER: "explicito", "outro": "1"}
            )

    import asyncio

    asyncio.run(executar())

    assert capturados[CORRELATION_HEADER] == "explicito"
    assert capturados["outro"] == "1"


def test_contexto_e_limpo_ao_sair():
    with log_context(correlation_id="temporario"):
        assert current_context().correlation_id == "temporario"

    assert current_context().correlation_id is None
