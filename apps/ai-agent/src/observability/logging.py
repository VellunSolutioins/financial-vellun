"""Contexto de correlacao e formatacao estruturada dos logs.

Todo log emitido dentro de ``log_context(...)`` carrega automaticamente
``correlationId``, ``providerMessageId``, ``jobId`` e ``phoneHash`` — o que
permite seguir um evento do webhook ate o lancamento criado.

Regra de privacidade: o telefone completo **nunca** vai para o log. Em producao
usamos o hash; em desenvolvimento, a versao mascarada, que ajuda a depurar sem
expor o numero inteiro.
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import asdict, dataclass, replace

from ..config import settings
from ..services.phone import hash_phone, mask_phone

#: Header de correlacao. A API principal usa exatamente este nome.
CORRELATION_HEADER = "x-correlation-id"

#: Limite e alfabeto do id aceito de fora. Sem validacao, um header com quebra de
#: linha injetaria uma linha falsa num log estruturado.
_MAX_CORRELATION_LENGTH = 128
_SAFE_CORRELATION = re.compile(r"^[A-Za-z0-9._:-]+$")


@dataclass(frozen=True)
class LogContext:
    correlation_id: str | None = None
    provider_message_id: str | None = None
    job_id: str | None = None
    phone_hash: str | None = None

    def as_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v}


_context: ContextVar[LogContext] = ContextVar("log_context", default=LogContext())


def current_context() -> LogContext:
    return _context.get()


@contextmanager
def log_context(
    *,
    correlation_id: str | None = None,
    provider_message_id: str | None = None,
    job_id: str | None = None,
    phone: str | None = None,
):
    """Adiciona campos ao contexto de log da tarefa atual."""
    base = _context.get()
    updates: dict = {}
    if correlation_id:
        updates["correlation_id"] = correlation_id
    if provider_message_id:
        updates["provider_message_id"] = provider_message_id
    if job_id:
        updates["job_id"] = job_id
    if phone:
        updates["phone_hash"] = safe_phone(phone)
    token = _context.set(replace(base, **updates))
    try:
        yield
    finally:
        _context.reset(token)


def safe_phone(phone: str | None) -> str:
    """Representacao do telefone segura para log, conforme o ambiente."""
    return hash_phone(phone) if settings.is_production else mask_phone(phone)


def new_correlation_id() -> str:
    return str(uuid.uuid4())


def sanitize_correlation_id(value: str | None) -> str:
    """Aceita o id vindo de fora quando e seguro; senao gera um.

    Aceitar o id do chamador e o que permite seguir um fluxo entre a API e o
    agente; deixar de valida-lo e o que permitiria injetar quebra de linha no log.
    """
    if not value:
        return new_correlation_id()

    candidate = value.strip()
    if (
        not candidate
        or len(candidate) > _MAX_CORRELATION_LENGTH
        or not _SAFE_CORRELATION.match(candidate)
    ):
        return new_correlation_id()
    return candidate


def correlation_headers() -> dict:
    """Headers para propagar a correlacao numa chamada de saida.

    Fora de um contexto devolve vazio, e nao um id novo: um id que existe so na
    chamada de saida nao correlaciona com nada e daria falsa impressao de rastro.
    """
    correlation_id = current_context().correlation_id
    return {CORRELATION_HEADER: correlation_id} if correlation_id else {}


class ContextFilter(logging.Filter):
    """Injeta o contexto atual em cada registro."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.context = current_context().as_dict()
        return True


class JsonFormatter(logging.Formatter):
    """Uma linha JSON por log — legivel por agregadores em producao."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            **getattr(record, "context", {}),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


class TextFormatter(logging.Formatter):
    """Formato legivel para desenvolvimento, com o contexto ao final."""

    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        context = getattr(record, "context", {})
        return f"{base} {context}" if context else base


def configure_logging(service: str = "ai-agent") -> None:
    """Configura o logger raiz.

    O uvicorn so configura os proprios loggers (``uvicorn*``), deixando o raiz
    sem handler — o que faria o Python descartar todo log INFO da aplicacao.

    ``service`` distingue a API do agente (``ai-agent``) do worker
    (``ai-agent-worker``) no Loki. Sao processos diferentes fazendo trabalhos
    diferentes, e misturar os dois num label so tornaria impossivel perguntar
    "o consumo esta com problema?".
    """
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    handler = logging.StreamHandler()
    handler.addFilter(ContextFilter())
    if settings.is_production:
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(
            TextFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        )

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    _attach_loki_handler(root, service)


def _attach_loki_handler(root: logging.Logger, service: str) -> None:
    """Adiciona o envio ao Loki quando ``LOKI_PUSH_URL`` esta definido.

    Sem a variavel o handler nao existe — em desenvolvimento nao ha Alloy, e um
    handler tentando conectar em nada geraria ruido sem beneficio. O envio e
    **sempre em JSON**, mesmo em desenvolvimento: o formato de texto existe para
    o terminal humano, nao para o agregador.
    """
    url = (os.getenv("LOKI_PUSH_URL") or "").strip()
    if not url:
        return

    from .loki_handler import LokiHandler

    # Poucos labels e todos de conjunto fechado: no Loki, label e indice, e
    # `correlationId` como label criaria um stream por mensagem. Ele vai no
    # **corpo** da linha, onde um filtro o encontra sem custo de cardinalidade.
    loki = LokiHandler(
        url,
        labels={
            "service": service,
            "env": "production" if settings.is_production else "development",
        },
    )
    loki.addFilter(ContextFilter())
    loki.setFormatter(JsonFormatter())
    root.addHandler(loki)
