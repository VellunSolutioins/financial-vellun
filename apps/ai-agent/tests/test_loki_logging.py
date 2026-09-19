"""Ligação do envio de log ao Loki.

O bug que estes testes fixam: o agente lia ``os.getenv("LOKI_PUSH_URL")``. O
pydantic-settings carrega o ``.env`` para o objeto ``settings``, mas **não** o
exporta para o ambiente do processo — então, com o valor só no ``.env``, o
handler nunca era criado e nada avisava. Só funcionava com a variável exportada
no shell, que é justamente como a verificação original foi feita.
"""

from __future__ import annotations

import logging
import os

import pytest

from src.config import Settings, settings
from src.observability import logging as obs_logging
from src.observability import loki_handler as loki_mod


class LokiFalso(logging.Handler):
    """Substitui o handler real, que sobe uma thread e registra ``atexit``."""

    criados: list[LokiFalso] = []

    def __init__(self, url: str, labels: dict[str, str]) -> None:
        super().__init__()
        self.url = url
        self.labels = labels
        LokiFalso.criados.append(self)

    def emit(self, record: logging.LogRecord) -> None:  # pragma: no cover - não usado
        pass


@pytest.fixture
def loki_falso(monkeypatch):
    LokiFalso.criados = []
    # `_attach_loki_handler` importa o handler na hora da chamada, então trocar o
    # atributo do módulo basta.
    monkeypatch.setattr(loki_mod, "LokiHandler", LokiFalso)
    return LokiFalso


@pytest.fixture
def alvo():
    """Logger isolado: o root é global e outros testes dependem dele."""
    return logging.Logger("teste-loki")


def test_settings_le_loki_push_url_do_arquivo_env(tmp_path, monkeypatch):
    monkeypatch.delenv("LOKI_PUSH_URL", raising=False)
    arquivo = tmp_path / ".env"
    arquivo.write_text(
        "INTERNAL_API_KEY=x\nLOKI_PUSH_URL=http://localhost:3100\n", encoding="utf-8"
    )

    carregado = Settings(_env_file=str(arquivo))

    assert carregado.loki_push_url == "http://localhost:3100"
    # E é por isso que não dá para ler com `os.getenv`: o `.env` não vai para o
    # ambiente do processo.
    assert os.getenv("LOKI_PUSH_URL") is None


def test_valor_vindo_do_settings_liga_o_envio(monkeypatch, loki_falso, alvo):
    monkeypatch.delenv("LOKI_PUSH_URL", raising=False)
    monkeypatch.setattr(settings, "loki_push_url", "http://localhost:3100")

    obs_logging._attach_loki_handler(alvo, "ai-agent")

    assert len(loki_falso.criados) == 1
    assert loki_falso.criados[0].url == "http://localhost:3100"
    assert loki_falso.criados[0] in alvo.handlers


def test_sem_url_nao_cria_handler(monkeypatch, loki_falso, alvo):
    monkeypatch.setattr(settings, "loki_push_url", "")

    obs_logging._attach_loki_handler(alvo, "ai-agent")

    assert loki_falso.criados == []
    assert alvo.handlers == []


def test_url_so_com_espacos_conta_como_ausente(monkeypatch, loki_falso, alvo):
    monkeypatch.setattr(settings, "loki_push_url", "   ")

    obs_logging._attach_loki_handler(alvo, "ai-agent")

    assert loki_falso.criados == []


@pytest.mark.parametrize(
    ("environment", "esperado"),
    [("development", "development"), ("production", "production")],
)
def test_labels_do_stream_sao_de_conjunto_fechado(
    monkeypatch, loki_falso, alvo, environment, esperado
):
    monkeypatch.setattr(settings, "loki_push_url", "http://localhost:3100")
    monkeypatch.setattr(settings, "environment", environment)

    obs_logging._attach_loki_handler(alvo, "ai-agent-worker")

    # Label no Loki é índice: só valores de conjunto fechado. `correlationId`
    # como label criaria um stream por mensagem.
    assert loki_falso.criados[0].labels == {"service": "ai-agent-worker", "env": esperado}
