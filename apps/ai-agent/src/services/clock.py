"""Data e hora no fuso da aplicação, sem depender do relógio do processo.

``date.today()`` usa o fuso do **processo**, e ele não é confiável: no Windows, um
processo que já nasce com ``TZ=America/Sao_Paulo`` no ambiente (o filho do
``uvicorn --reload`` herda a variável do pai) interpreta o nome IANA como
``UTC+1`` com horário de verão. Às 20h em Brasília o agente achava que já era o
dia seguinte, mandava essa "data atual" ao LLM e o lançamento era gravado com a
data de amanhã.

Aqui o instante vem sempre em UTC e é convertido explicitamente com ``zoneinfo``
— igual em Linux, Windows e no container. Toda data de negócio ("hoje", "ontem")
deve sair destas funções.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

#: O produto é brasileiro: "hoje" é o dia em Brasília, onde quer que o processo rode.
APP_TIMEZONE = ZoneInfo("America/Sao_Paulo")


def now_local(now: datetime | None = None) -> datetime:
    """Instante atual (ou ``now``, para testes) no fuso da aplicação."""
    instante = now if now is not None else datetime.now(timezone.utc)
    return instante.astimezone(APP_TIMEZONE)


def today_local(now: datetime | None = None) -> date:
    """Dia atual em Brasília."""
    return now_local(now).date()
