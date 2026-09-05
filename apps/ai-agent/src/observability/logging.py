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
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import asdict, dataclass, replace

from ..config import settings
from ..services.phone import hash_phone, mask_phone


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


def configure_logging() -> None:
    """Configura o logger raiz.

    O uvicorn so configura os proprios loggers (``uvicorn*``), deixando o raiz
    sem handler — o que faria o Python descartar todo log INFO da aplicacao.
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
