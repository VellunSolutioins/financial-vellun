"""Endpoints de observabilidade: token, formato e o servidor do worker.

O worker não tinha HTTP nenhum, então as réplicas de consumo — onde o trabalho
acontece — eram invisíveis para o scrape e para o orquestrador. Aqui verificamos
que ele passou a expor as mesmas métricas e os mesmos health checks.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from src.config import settings
from src.observability import worker_server
from src.services.metrics import metrics

TOKEN = "token-de-teste"


@pytest.fixture
def client():
    from src.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def com_token(monkeypatch):
    monkeypatch.setattr(settings, "metrics_token", TOKEN)


@pytest.fixture
def sem_token(monkeypatch):
    monkeypatch.setattr(settings, "metrics_token", "")


def auth(token: str = TOKEN) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── API do agente ────────────────────────────────────────────────────────────
def test_metrics_devolve_texto_prometheus(client, com_token):
    resposta = client.get("/metrics", headers=auth())

    assert resposta.status_code == 200
    assert "text/plain" in resposta.headers["content-type"]
    assert "# TYPE vellun_agent_messages_consumed_total counter" in resposta.text


def test_metrics_json_preserva_o_shape_antigo(client, com_token):
    # `scripts/monitor.py` e `scripts/loadtest.py` dependem deste formato.
    resposta = client.get("/metrics.json", headers=auth())

    assert resposta.status_code == 200
    corpo = resposta.json()
    assert set(corpo) == {"counters", "timings"}
    assert "webhook_received" in corpo["counters"]
    assert "avg_ms" in corpo["timings"]["webhook_latency_ms"]


def test_metrics_recusa_sem_token_e_com_token_errado(client, com_token):
    assert client.get("/metrics").status_code == 401
    assert client.get("/metrics", headers=auth("errado")).status_code == 401
    assert client.get("/metrics.json", headers=auth("errado")).status_code == 401


def test_metrics_liberado_sem_token_em_desenvolvimento(client, sem_token, monkeypatch):
    # Exigir token no dev local só atrapalharia.
    monkeypatch.setattr(settings, "environment", "development")

    assert client.get("/metrics").status_code == 200


def test_metrics_fechado_sem_token_em_producao(client, sem_token, monkeypatch):
    # Variável esquecida no deploy não pode virar exposição pública.
    monkeypatch.setattr(settings, "environment", "production")

    assert client.get("/metrics").status_code == 401


def test_health_live_nao_depende_de_nada(client):
    assert client.get("/health/live").json() == {"status": "ok"}


# ── Servidor do worker ───────────────────────────────────────────────────────
async def call_worker(path: str, headers: list[tuple[bytes, bytes]] | None = None):
    """Chama a app ASGI do worker sem subir servidor de verdade."""
    scope = {"type": "http", "method": "GET", "path": path, "headers": headers or []}
    enviados: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        enviados.append(message)

    await worker_server.app(scope, receive, send)

    start = next(m for m in enviados if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in enviados if m["type"] == "http.response.body")
    return start["status"], dict(start["headers"]), body


async def test_worker_expoe_liveness():
    status, _, body = await call_worker("/health/live")

    assert status == 200
    assert json.loads(body) == {"status": "ok"}


async def test_worker_expoe_metricas_prometheus(com_token):
    status, headers, body = await call_worker(
        "/metrics", [(b"authorization", f"Bearer {TOKEN}".encode())]
    )

    assert status == 200
    assert b"text/plain" in headers[b"content-type"]
    assert b"vellun_agent_" in body


async def test_worker_aplica_a_mesma_regra_de_token(com_token):
    status, _, _ = await call_worker("/metrics")
    assert status == 401

    status, _, _ = await call_worker(
        "/metrics", [(b"authorization", b"Bearer errado")]
    )
    assert status == 401


async def test_worker_expoe_readiness_do_pipeline(com_token):
    # Sem consumers rodando o pipeline não está pronto — e é isso que o
    # orquestrador precisa ver, em vez de nenhuma porta aberta.
    status, _, body = await call_worker("/health/ready")

    assert status in (200, 503)
    assert "status" in json.loads(body)


async def test_worker_responde_404_no_resto():
    # A superfície é deliberadamente mínima: só observabilidade.
    status, _, _ = await call_worker("/webhook/whatsapp")

    assert status == 404


async def test_worker_e_a_api_leem_o_mesmo_coletor(com_token):
    """Um contador incrementado no worker aparece na exposição do worker.

    O ponto é que existe **um** coletor por processo: se o worker tivesse o seu
    próprio, o número visto no scrape não seria o do trabalho realizado.
    """
    antes = metrics.snapshot()["counters"]["jobs_processed"]
    metrics.incr("jobs_processed")

    _, _, body = await call_worker(
        "/metrics.json", [(b"authorization", f"Bearer {TOKEN}".encode())]
    )

    assert json.loads(body)["counters"]["jobs_processed"] == antes + 1
