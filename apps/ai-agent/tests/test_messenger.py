"""Messenger: falha de entrega e configuração inválida não podem ser silenciosas.

Antes, as duas coisas degradavam sem sinal: provider ausente virava
``LogMessenger`` e a recusa da Graph API virava um ``warning``. O pipeline
reportava sucesso ponta a ponta e o usuário nunca recebia resposta.
"""

from __future__ import annotations

import httpx
import pytest

from src.config import settings
from src.messaging.base import PermanentError, TransientError
from src.services.messenger import MessengerConfigError, create_messenger
from src.services.messenger.cloud_api_messenger import WhatsappCloudApiMessenger
from src.services.messenger.log_messenger import LogMessenger


@pytest.fixture
def cloud_config(monkeypatch):
    monkeypatch.setattr(settings, "whatsapp_provider", "cloud-api")
    monkeypatch.setattr(settings, "whatsapp_provider_token", "token-de-teste")
    monkeypatch.setattr(settings, "whatsapp_phone_number_id", "123")


@pytest.fixture
def producao(monkeypatch):
    monkeypatch.setattr(settings, "environment", "production")


# ── Factory ──────────────────────────────────────────────────────────────────
def test_dev_sem_provider_usa_log(monkeypatch):
    monkeypatch.setattr(settings, "whatsapp_provider", "log")

    assert isinstance(create_messenger(), LogMessenger)


def test_dev_com_cloud_api_incompleto_cai_para_log(monkeypatch):
    monkeypatch.setattr(settings, "whatsapp_provider", "cloud-api")
    monkeypatch.setattr(settings, "whatsapp_provider_token", "")

    assert isinstance(create_messenger(), LogMessenger)


def test_producao_com_provider_log_nao_sobe(monkeypatch, producao):
    monkeypatch.setattr(settings, "whatsapp_provider", "log")

    with pytest.raises(MessengerConfigError, match="WHATSAPP_PROVIDER=log"):
        create_messenger()


def test_producao_com_token_ausente_nao_sobe(monkeypatch, producao, cloud_config):
    monkeypatch.setattr(settings, "whatsapp_provider_token", "")

    with pytest.raises(MessengerConfigError, match="WHATSAPP_PROVIDER_TOKEN"):
        create_messenger()


def test_producao_com_provider_desconhecido_nao_sobe(monkeypatch, producao):
    monkeypatch.setattr(settings, "whatsapp_provider", "twilio")

    with pytest.raises(MessengerConfigError, match="desconhecido"):
        create_messenger()


def test_producao_com_cloud_api_completo_sobe(producao, cloud_config):
    assert isinstance(create_messenger(), WhatsappCloudApiMessenger)


# ── Entrega pela Cloud API ───────────────────────────────────────────────────
def cloud_messenger(handler) -> WhatsappCloudApiMessenger:
    messenger = WhatsappCloudApiMessenger()
    messenger._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return messenger


async def test_entrega_aceita_nao_levanta(cloud_config):
    enviados: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        enviados.append(request.read().decode())
        return httpx.Response(200, json={"messages": [{"id": "wamid.out"}]})

    await cloud_messenger(handler).send("+5541999999999", "oi")

    assert len(enviados) == 1
    assert '"to":"5541999999999"' in enviados[0].replace(" ", "")


@pytest.mark.parametrize("status", [429, 500, 503])
async def test_indisponibilidade_da_meta_e_transitoria(cloud_config, status):
    messenger = cloud_messenger(lambda request: httpx.Response(status, json={}))

    with pytest.raises(TransientError):
        await messenger.send("+5541999999999", "oi")


@pytest.mark.parametrize("status", [400, 401, 403])
async def test_recusa_da_meta_e_permanente(cloud_config, status):
    corpo = {"error": {"code": 190, "message": "Error validating access token"}}
    messenger = cloud_messenger(lambda request: httpx.Response(status, json=corpo))

    with pytest.raises(PermanentError, match="code=190"):
        await messenger.send("+5541999999999", "oi")


async def test_falha_de_rede_e_transitoria(cloud_config):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sem rota", request=request)

    with pytest.raises(TransientError, match="ConnectError"):
        await cloud_messenger(handler).send("+5541999999999", "oi")


async def test_erro_nao_expoe_o_token(cloud_config):
    messenger = cloud_messenger(lambda request: httpx.Response(401, text="nao json"))

    with pytest.raises(PermanentError) as exc:
        await messenger.send("+5541999999999", "oi")

    assert "token-de-teste" not in str(exc.value)
