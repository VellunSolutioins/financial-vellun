"""O `.env.example` é o que alguém copia para subir o agente.

Variável que existe em `Settings` e não aparece no exemplo só é descoberta lendo
o código — foi o caso de `LOG_LEVEL` e das chaves do catálogo de falhas.
"""

from __future__ import annotations

import re
from pathlib import Path

from src.config import Settings

ENV_EXAMPLE = Path(__file__).resolve().parent.parent / ".env.example"


def test_env_example_lista_toda_configuracao():
    declaradas = set(
        re.findall(r"^([A-Z0-9_]+)=", ENV_EXAMPLE.read_text(encoding="utf-8"), re.MULTILINE)
    )
    esperadas = {campo.upper() for campo in Settings.model_fields}

    assert sorted(esperadas - declaradas) == []
