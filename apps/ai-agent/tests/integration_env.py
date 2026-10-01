"""Onde estão o RabbitMQ e o Redis dos testes de integração, e o que fazer sem eles.

As URLs vêm da variável de ambiente e, sem ela, da configuração do agente (o
``.env``). Antes o padrão era ``guest:guest`` e Redis sem senha: desde que o
compose exige credenciais, a suíte inteira era **pulada** com a infraestrutura
no ar, e "11 skipped" parecia verde.

Com ``INTEGRATION_REQUIRED=1`` (o CI), infraestrutura fora do ar é falha, não
pulo. Sem a variável, o uso local continua pulando com o motivo.
"""

from __future__ import annotations

import os

import pytest

from src.config import settings

RABBITMQ_URL = os.getenv("RABBITMQ_URL") or settings.rabbitmq_url
REDIS_URL = os.getenv("REDIS_URL") or settings.redis_url

REQUIRED = os.getenv("INTEGRATION_REQUIRED", "").strip().lower() in ("1", "true", "yes")


def unavailable(service: str, exc: BaseException) -> None:
    """Pula ou falha o teste. A URL fica de fora da mensagem: ela leva a senha."""
    reason = f"{service} indisponível: {exc}"
    if REQUIRED:
        pytest.fail(reason)
    pytest.skip(reason)
