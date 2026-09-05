"""Nomes de exchanges, filas e routing keys derivados da configuração.

Centralizado aqui para que topologia, publisher, consumer e o runbook
operacional falem exatamente dos mesmos nomes.
"""

from __future__ import annotations

import re

from .retry import RETRY_BUCKETS_SECONDS

EXCHANGE_MAIN = "whatsapp.x"
EXCHANGE_RETRY = "whatsapp.retry.x"
EXCHANGE_DLX = "whatsapp.dlx"

_VERSION_SUFFIX = re.compile(r"\.v\d+$")


def base_name(queue: str) -> str:
    """``whatsapp.inbound.v1`` → ``whatsapp.inbound`` (sem o sufixo de versão)."""
    return _VERSION_SUFFIX.sub("", queue)


def retry_queue(queue: str, bucket_seconds: int) -> str:
    """``whatsapp.inbound.v1`` + 4 → ``whatsapp.inbound.retry.4s``."""
    return f"{base_name(queue)}.retry.{bucket_seconds}s"


def retry_routing_key(routing_key: str, bucket_seconds: int) -> str:
    return f"{routing_key}.retry.{bucket_seconds}s"


def dlq_queue(queue: str) -> str:
    """``whatsapp.inbound.v1`` → ``whatsapp.inbound.dlq``."""
    return f"{base_name(queue)}.dlq"


def dlq_routing_key(routing_key: str) -> str:
    return f"{routing_key}.dlq"


def all_retry_queues(queue: str) -> list[tuple[str, int]]:
    """Todas as filas de retry de uma fila principal, com seus TTLs."""
    return [(retry_queue(queue, bucket), bucket) for bucket in RETRY_BUCKETS_SECONDS]
