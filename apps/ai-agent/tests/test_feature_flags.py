"""Leitura das feature flags da API: na dúvida, tudo desligado."""

from __future__ import annotations

import pytest

from src.services import feature_flags as module
from src.services.feature_flags import FeatureFlags


class _Resposta:
    def __init__(self, status: int, body) -> None:
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class _Api:
    def __init__(self, resposta) -> None:
        self.resposta = resposta
        self.paths: list[str] = []

    async def get(self, path):
        self.paths.append(path)
        if isinstance(self.resposta, Exception):
            raise self.resposta
        return self.resposta


async def test_le_as_flags_da_api(monkeypatch):
    api = _Api(_Resposta(200, {"whatsapp_summary": True, "notes": False}))
    monkeypatch.setattr(module, "api_client", api)

    # O conftest troca o método da instância global; aqui vale uma instância nova.
    assert await FeatureFlags().enabled() == {"whatsapp_summary": True, "notes": False}
    assert api.paths == ["/internal/features"]


@pytest.mark.parametrize("falha", [_Resposta(500, {}), _Resposta(200, []), TimeoutError()])
async def test_sem_resposta_valida_nada_esta_ligado(monkeypatch, falha):
    monkeypatch.setattr(module, "api_client", _Api(falha))
    assert await FeatureFlags().enabled() == {}
