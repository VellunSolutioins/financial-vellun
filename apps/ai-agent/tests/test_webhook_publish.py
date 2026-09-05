"""Webhook: assinatura, publicação confirmada e códigos de resposta.

Cobre os casos obrigatórios 1 a 6:

1. webhook válido publica uma mensagem e retorna 202;
2. o 202 só sai depois do publisher confirm;
3. falha de publicação retorna 503;
4. assinatura inválida retorna 401 e não publica;
5. payload com várias mensagens publica todas;
6. evento de status não vira job financeiro.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from src.bootstrap import pipeline
from src.config import settings
from src.main import app
from src.messaging.base import PublishError
from src.messaging.contracts import InboundMessageV1

SIMPLE_PAYLOAD = {
    "phone": "+5541999999999",
    "message": "gastei 47,50 no mercado",
    "message_id": "wamid.1",
}


def meta_payload(*messages: dict) -> dict:
    return {
        "object": "whatsapp_business_account",
        "entry": [{"changes": [{"value": {"messages": list(messages)}}]}],
    }


def text_message(msg_id: str, body: str) -> dict:
    return {
        "from": "5541999999999",
        "id": msg_id,
        "type": "text",
        "timestamp": "1757000000",
        "text": {"body": body},
    }


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def published(broker) -> list[InboundMessageV1]:
    return [
        InboundMessageV1.model_validate_json(m.body) for m in broker.published["inbound"]
    ]


def test_webhook_valido_publica_e_retorna_202(client, broker):
    response = client.post("/webhook/whatsapp", json=SIMPLE_PAYLOAD)

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "published": 1}

    messages = published(broker)
    assert len(messages) == 1
    assert messages[0].provider_message_id == "wamid.1"
    assert messages[0].text == "gastei 47,50 no mercado"
    # Telefone normalizado para E.164, igual à chave usada pela API.
    assert messages[0].phone == "+5541999999999"
    assert messages[0].schema_version == 1
    assert messages[0].correlation_id


def test_202_so_depois_do_publisher_confirm(client, broker, monkeypatch):
    """A resposta não pode sair antes de o broker confirmar a publicação."""
    confirmed: list[str] = []
    original = type(pipeline.publisher).publish

    async def slow_publish(self, routing_key, message, **kwargs):
        # Simula a latência do confirm: a mensagem só existe depois do await.
        await asyncio.sleep(0.05)
        await original(self, routing_key, message, **kwargs)
        confirmed.append(message.event_id)

    monkeypatch.setattr(type(pipeline.publisher), "publish", slow_publish)

    response = client.post("/webhook/whatsapp", json=SIMPLE_PAYLOAD)

    assert response.status_code == 202
    # Quando a resposta chegou, o confirm já havia acontecido.
    assert len(confirmed) == 1
    assert len(broker.published["inbound"]) == 1


def test_falha_de_publicacao_retorna_503(client, broker):
    broker.fail_publish = PublishError("broker indisponível")

    response = client.post("/webhook/whatsapp", json=SIMPLE_PAYLOAD)

    assert response.status_code == 503
    assert broker.published["inbound"] == []


def test_publisher_ausente_retorna_503(client, broker, monkeypatch):
    """Se o publisher não subiu, o webhook não pode aceitar o evento."""
    monkeypatch.setattr(pipeline, "publisher", None)

    response = client.post("/webhook/whatsapp", json=SIMPLE_PAYLOAD)

    assert response.status_code == 503


def test_assinatura_invalida_retorna_401_e_nao_publica(client, broker, monkeypatch):
    monkeypatch.setattr(settings, "whatsapp_webhook_secret", "segredo-do-app")

    response = client.post(
        "/webhook/whatsapp",
        json=SIMPLE_PAYLOAD,
        headers={"X-Hub-Signature-256": "sha256=deadbeef"},
    )

    assert response.status_code == 401
    assert broker.published["inbound"] == []


def test_assinatura_valida_e_aceita(client, broker, monkeypatch):
    secret = "segredo-do-app"
    monkeypatch.setattr(settings, "whatsapp_webhook_secret", secret)
    body = json.dumps(SIMPLE_PAYLOAD).encode()
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    response = client.post(
        "/webhook/whatsapp",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Hub-Signature-256": f"sha256={digest}",
        },
    )

    assert response.status_code == 202
    assert len(broker.published["inbound"]) == 1


def test_payload_com_varias_mensagens_publica_todas(client, broker):
    payload = meta_payload(
        text_message("wamid.1", "gastei"),
        text_message("wamid.2", "47,50"),
        text_message("wamid.3", "no mercado"),
    )

    response = client.post("/webhook/whatsapp", json=payload)

    assert response.status_code == 202
    assert response.json()["published"] == 3
    ids = [m.provider_message_id for m in published(broker)]
    assert ids == ["wamid.1", "wamid.2", "wamid.3"]
    # Uma única correlação para todo o evento recebido.
    assert len({m.correlation_id for m in published(broker)}) == 1


def test_evento_de_status_nao_cria_job(client, broker):
    payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {"changes": [{"value": {"statuses": [{"id": "wamid.1", "status": "read"}]}}]}
        ],
    }

    response = client.post("/webhook/whatsapp", json=payload)

    assert response.status_code == 200
    assert response.json() == {"status": "ignored"}
    assert broker.published["inbound"] == []
    assert broker.published["processing"] == []


def test_mensagem_longa_demais_nao_e_publicada(client, broker, monkeypatch):
    monkeypatch.setattr(settings, "message_max_chars", 10)

    response = client.post(
        "/webhook/whatsapp",
        json={**SIMPLE_PAYLOAD, "message": "x" * 50},
    )

    assert response.status_code == 200
    assert response.json() == {"status": "ignored"}
    assert broker.published["inbound"] == []


def test_webhook_nao_toca_api_banco_openai_nem_midia(client, broker, monkeypatch):
    """O ciclo HTTP não pode chamar API principal, LLM ou baixar mídia."""
    import src.services.api_client as api_client_module
    import src.services.intent_classifier as classifier_module
    import src.services.whatsapp_media as media_module

    def explode(*_args, **_kwargs):
        raise AssertionError("o webhook não pode fazer esta chamada")

    fake = type(
        "Fake",
        (),
        {
            "get": staticmethod(explode),
            "post": staticmethod(explode),
            "classify": staticmethod(explode),
            "fetch": staticmethod(explode),
        },
    )()
    monkeypatch.setattr(api_client_module, "api_client", fake)
    monkeypatch.setattr(classifier_module, "intent_classifier", fake)
    monkeypatch.setattr(media_module, "whatsapp_media", fake)

    audio = {
        "from": "5541999999999",
        "id": "wamid.audio",
        "type": "audio",
        "timestamp": "1757000000",
        "audio": {"id": "media-1", "mime_type": "audio/ogg"},
    }
    response = client.post("/webhook/whatsapp", json=meta_payload(audio))

    assert response.status_code == 202
    message = published(broker)[0]
    assert message.kind == "audio"
    # Só a referência da mídia viaja na fila; o binário fica com o consumer.
    assert message.media_id == "media-1"


def test_handshake_get_continua_funcionando(client, monkeypatch):
    monkeypatch.setattr(settings, "whatsapp_verify_token", "token-da-meta")

    response = client.get(
        "/webhook/whatsapp",
        params={
            "hub.mode": "subscribe",
            "hub.verify_token": "token-da-meta",
            "hub.challenge": "12345",
        },
    )

    assert response.status_code == 200
    assert response.text == "12345"
