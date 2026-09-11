"""`POST /internal/ops/reprocess`: allowlist, contrato e códigos de resposta.

O código de status é o contrato com a API principal: ela decide entre devolver a
linha do catálogo para `pending` (certeza de que nada foi publicado) e deixá-la
em `reprocessing` para o cron (não se sabe). Estes testes fixam essa distinção.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from src.bootstrap import pipeline
from src.main import app
from src.messaging.base import PublishError
from src.messaging.contracts import InboundMessageV1, ProcessingJobV1

CHAVE = {"x-internal-api-key": "test-internal-key"}

INBOUND = {
    "schemaVersion": 1,
    "eventId": "evt-1",
    "phone": "+5541999999999",
    "kind": "text",
    "text": "gastei 47,50 no mercado",
    "providerMessageId": "wamid.1",
    "correlationId": "corr-1",
}

JOB = {
    "schemaVersion": 1,
    "jobId": "job-1",
    "phone": "+5541999999999",
    "combinedMessage": "gastei 47,50 no mercado",
    "sourceMessageIds": ["evt-1"],
    "providerMessageIds": ["wamid.1"],
    "correlationId": "corr-1",
}


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def pedir(client, **corpo):
    return client.post("/internal/ops/reprocess", json=corpo, headers=CHAVE)


def test_sem_chave_interna_nao_publica(client, broker):
    resposta = client.post(
        "/internal/ops/reprocess", json={"route": "inbound", "message": INBOUND}
    )

    assert resposta.status_code == 401
    assert broker.published["inbound"] == []


def test_republica_inbound_com_o_payload_original(client, broker):
    resposta = pedir(client, route="inbound", message=INBOUND, correlationId="corr-1")

    assert resposta.status_code == 200
    assert resposta.json() == {"status": "published", "route": "inbound"}

    publicadas = [
        InboundMessageV1.model_validate_json(m.body) for m in broker.published["inbound"]
    ]
    assert len(publicadas) == 1
    # O payload sai idêntico: é isso que faz a idempotência do pipeline valer —
    # o mesmo `providerMessageId` não vira um segundo lançamento.
    assert publicadas[0].provider_message_id == "wamid.1"
    assert publicadas[0].correlation_id == "corr-1"


def test_republica_processing_no_destino_proprio(client, broker):
    resposta = pedir(client, route="processing", message=JOB)

    assert resposta.status_code == 200
    publicadas = [
        ProcessingJobV1.model_validate_json(m.body) for m in broker.published["processing"]
    ]
    assert len(publicadas) == 1
    assert publicadas[0].job_id == "job-1"
    assert broker.published["inbound"] == []


def test_rota_fora_da_allowlist_e_recusada(client, broker):
    for rota in ["inbound.dlq", "whatsapp.x", "processing.retry.4s", ""]:
        resposta = pedir(client, route=rota, message=INBOUND)

        assert resposta.status_code == 422, rota
    assert broker.published["inbound"] == []
    assert broker.published["processing"] == []


def test_payload_invalido_devolve_422_sem_publicar(client, broker):
    """Republicar sem validar devolveria a mensagem à mesma DLQ, com uma
    tentativa a mais — e payload malformado é justamente um dos motivos de ela
    ter ido parar lá."""
    resposta = pedir(client, route="inbound", message={**INBOUND, "text": "   "})

    assert resposta.status_code == 422
    assert broker.published["inbound"] == []


def test_payload_de_outra_rota_nao_passa(client, broker):
    """Um `ProcessingJobV1` publicado em `inbound` só falharia no consumer."""
    resposta = pedir(client, route="inbound", message=JOB)

    assert resposta.status_code == 422
    assert broker.published["inbound"] == []


def test_sem_confirm_do_broker_devolve_503(client, broker, monkeypatch):
    async def publish_falha(self, routing_key, message, **kwargs):
        raise PublishError("broker fora")

    monkeypatch.setattr(type(pipeline.publisher), "publish", publish_falha)

    resposta = pedir(client, route="inbound", message=INBOUND)

    # 503 é deliberadamente ambíguo: um confirm que não chega não prova que a
    # publicação não aconteceu, e a API deixa a linha em `reprocessing`.
    assert resposta.status_code == 503
    assert broker.published["inbound"] == []


def test_campo_desconhecido_no_pedido_e_recusado(client, broker):
    """`extra="forbid"`: um destino extra no corpo não pode passar despercebido."""
    resposta = client.post(
        "/internal/ops/reprocess",
        json={"route": "inbound", "message": INBOUND, "exchange": "whatsapp.x"},
        headers=CHAVE,
    )

    assert resposta.status_code == 422
    assert broker.published["inbound"] == []
