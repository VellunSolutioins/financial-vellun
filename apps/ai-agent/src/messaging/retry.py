"""Backoff exponencial com jitter, materializado em filas de retry por bucket.

RabbitMQ atrasa mensagens via ``x-message-ttl`` + dead-letter de volta à fila de
origem. Usar TTL *por mensagem* numa fila única causaria *head-of-line blocking*
(uma mensagem com TTL longo segura as de trás), então usamos **buckets de TTL
fixo** e escolhemos o bucket pelo número da tentativa. O jitter é aplicado como
uma espera curta antes da republicação, o suficiente para desalinhar rajadas.
"""

from __future__ import annotations

import random

#: TTLs (em segundos) das filas de retry declaradas na topologia.
RETRY_BUCKETS_SECONDS: tuple[int, ...] = (1, 4, 16, 60, 300)

#: Teto do jitter aplicado antes de republicar (segundos).
MAX_JITTER_SECONDS = 0.8


def backoff_seconds(attempt: int, base_seconds: float, max_seconds: float) -> float:
    """Atraso teórico da tentativa ``attempt`` (0-based): ``base * 2**attempt``."""
    exponent = max(attempt, 0)
    return min(base_seconds * (2**exponent), max_seconds)


def bucket_for(attempt: int, base_seconds: float, max_seconds: float) -> int:
    """Menor bucket declarado que cobre o backoff da tentativa."""
    target = backoff_seconds(attempt, base_seconds, max_seconds)
    for bucket in RETRY_BUCKETS_SECONDS:
        if bucket >= target:
            return bucket
    return RETRY_BUCKETS_SECONDS[-1]


def jitter_seconds() -> float:
    """Jitter aleatório curto, para evitar reprocessamento em rajada."""
    return random.uniform(0.0, MAX_JITTER_SECONDS)
