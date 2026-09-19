""""Hoje" é o dia em Brasília, não o dia do relógio do processo.

Incidente: no Windows, o processo filho do ``uvicorn --reload`` nascia com
``TZ=America/Sao_Paulo`` e o runtime C lia isso como UTC+1. Às 20h em Brasília o
agente mandava ao LLM a data de amanhã, e o lançamento era gravado com ela.
"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from src.services.clock import now_local, today_local

RAIZ = Path(__file__).resolve().parent.parent


@pytest.mark.parametrize(
    ("utc", "esperado"),
    [
        # 20h em Brasília: ainda é o mesmo dia, embora em UTC já sejam 23h.
        (datetime(2026, 9, 16, 23, 0, tzinfo=timezone.utc), date(2026, 9, 16)),
        # Meia-noite e meia em UTC ainda é 21h30 do dia anterior em Brasília.
        (datetime(2026, 9, 17, 0, 30, tzinfo=timezone.utc), date(2026, 9, 16)),
        # 3h UTC é meia-noite em Brasília: aí sim vira o dia.
        (datetime(2026, 9, 17, 3, 0, tzinfo=timezone.utc), date(2026, 9, 17)),
    ],
)
def test_hoje_e_o_dia_em_brasilia(utc, esperado):
    assert today_local(utc) == esperado


def test_hora_local_carrega_o_fuso_de_brasilia():
    local = now_local(datetime(2026, 9, 16, 23, 0, tzinfo=timezone.utc))

    assert local.hour == 20
    assert local.utcoffset().total_seconds() == -3 * 3600


@pytest.mark.parametrize("tz", ["America/Sao_Paulo", "UTC", "Asia/Tokyo"])
def test_hoje_nao_depende_do_tz_com_que_o_processo_nasce(tz):
    """O cenário exato do incidente: `TZ` já presente quando o processo inicia."""
    codigo = (
        "from datetime import datetime, timezone;"
        "import src.config;"
        "from src.services.clock import today_local;"
        "print(today_local(), today_local(datetime.now(timezone.utc)))"
    )
    ambiente = {**os.environ, "TZ": tz, "INTERNAL_API_KEY": "teste", "LOKI_PUSH_URL": ""}

    saida = subprocess.run(
        [sys.executable, "-c", codigo],
        cwd=RAIZ,
        env=ambiente,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()

    assert saida[0] == saida[1] == today_local().isoformat()
