"""Configuração segura por padrão (plano de segurança, S1.4).

Antes, ``ENVIRONMENT`` assumia ``development``: um deploy que esquecesse a
variável aceitava webhook sem assinatura, inclusive com números de terceiros.
Agora a ausência vale produção, e configuração insegura impede o boot.
"""

from __future__ import annotations

import json
import logging

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from src.config import Settings, settings
from src.main import app
from src.services.conversation_store import ConversationState
from src.services.messenger.log_messenger import LogMessenger

SECRET = "s" * 32

PRODUCAO_OK = {
    "environment": "production",
    "internal_api_key": SECRET,
    "whatsapp_webhook_secret": SECRET,
    "metrics_token": SECRET,
    "whatsapp_provider": "cloud-api",
    "webhook_allow_unsigned": False,
}


def criar(**overrides) -> Settings:
    # `_env_file=None`: o `.env` do desenvolvedor não pode mudar o resultado.
    return Settings(_env_file=None, **{**PRODUCAO_OK, **overrides})


def test_ambiente_ausente_vale_producao(monkeypatch):
    monkeypatch.delenv("ENVIRONMENT", raising=False)

    with pytest.raises(ValidationError):
        Settings(_env_file=None, internal_api_key=SECRET)


def test_producao_completa_sobe():
    config = criar()
    assert config.is_production
    assert not config.is_local


@pytest.mark.parametrize(
    ("campo", "valor", "trecho"),
    [
        ("whatsapp_webhook_secret", "", "WHATSAPP_WEBHOOK_SECRET"),
        ("webhook_allow_unsigned", True, "WEBHOOK_ALLOW_UNSIGNED"),
        ("internal_api_key", "curta", "INTERNAL_API_KEY"),
        ("metrics_token", "", "METRICS_TOKEN"),
        ("whatsapp_provider", "log", "WHATSAPP_PROVIDER"),
    ],
)
def test_producao_insegura_nao_sobe(campo, valor, trecho):
    with pytest.raises(ValidationError, match=trecho):
        criar(**{campo: valor})


def test_ambiente_desconhecido_recebe_regras_de_producao():
    # "staging" não é local: sem as garantias de produção, não sobe.
    with pytest.raises(ValidationError):
        criar(environment="staging", whatsapp_webhook_secret="")


def test_desenvolvimento_dispensa_as_exigencias():
    config = criar(
        environment="development",
        whatsapp_webhook_secret="",
        metrics_token="",
        whatsapp_provider="log",
        webhook_allow_unsigned=True,
    )
    assert config.is_local


# ── Webhook ──────────────────────────────────────────────────────────────────
@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


PAYLOAD = {
    "phone": "+5541999999999",
    "message": "gastei 10",
    "messageId": "wamid.cfg",
}


def test_sem_secret_e_sem_opcao_explicita_o_webhook_recusa(client, broker, monkeypatch):
    monkeypatch.setattr(settings, "whatsapp_webhook_secret", "")
    monkeypatch.setattr(settings, "webhook_allow_unsigned", False)

    response = client.post("/webhook/whatsapp", json=PAYLOAD)

    assert response.status_code == 401
    assert broker.published["inbound"] == []


def test_opcao_de_simulacao_nao_vale_fora_do_ambiente_local(client, broker, monkeypatch):
    monkeypatch.setattr(settings, "whatsapp_webhook_secret", "")
    monkeypatch.setattr(settings, "webhook_allow_unsigned", True)
    monkeypatch.setattr(settings, "environment", "production")

    response = client.post("/webhook/whatsapp", json=PAYLOAD)

    assert response.status_code == 401


# ── LogMessenger ─────────────────────────────────────────────────────────────
async def test_log_messenger_fora_do_local_nao_grava_numero_nem_texto(monkeypatch, caplog):
    monkeypatch.setattr(settings, "environment", "production")
    caplog.set_level(logging.INFO)

    await LogMessenger().send("+5541999998888", "Saldo: R$ 1.234,56")

    assert "999998888" not in caplog.text
    assert "1.234,56" not in caplog.text


async def test_log_messenger_local_mostra_texto_com_numero_mascarado(caplog):
    caplog.set_level(logging.INFO)

    await LogMessenger().send("+5541999998888", "Lançamento criado")

    assert "Lançamento criado" in caplog.text
    assert "+5541999998888" not in caplog.text


# ── Estado conversacional ────────────────────────────────────────────────────
def test_estado_v1_sem_vinculo_e_descartado():
    antigo = json.dumps(
        {"v": 1, "pendingIntent": None, "awaitingConfirmation": True, "lastMessageAt": None}
    )
    assert ConversationState.from_json(antigo) is None


def test_vinculo_sobrevive_a_serializacao():
    state = ConversationState(
        awaiting_confirmation=True, user_id="u1", contact_id="c1", link_version=3
    )
    restored = ConversationState.from_json(state.to_json())

    assert restored is not None
    assert restored.belongs_to({"userId": "u1", "contactId": "c1", "linkVersion": 3})
    assert not restored.belongs_to({"userId": "u1", "contactId": "c1", "linkVersion": 4})
