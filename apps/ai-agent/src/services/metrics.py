"""Métricas em memória do agente (§12 / Etapa 5).

Coletor simples e thread-safe-o-suficiente para single-process: contadores e
acumuladores de latência. Exposto via ``GET /metrics``. Em produção com
múltiplas instâncias, exportar para Prometheus/StatsD (fora do escopo do MVP).
"""

from __future__ import annotations

import threading
from collections import defaultdict


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: dict[str, int] = defaultdict(int)
        # nome -> (soma, contagem) para latências em milissegundos.
        self._timings: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])

    def incr(self, name: str, amount: int = 1) -> None:
        with self._lock:
            self._counters[name] += amount

    def observe_ms(self, name: str, value_ms: float) -> None:
        with self._lock:
            acc = self._timings[name]
            acc[0] += value_ms
            acc[1] += 1

    def snapshot(self) -> dict:
        with self._lock:
            counters = dict(self._counters)
            timings = {
                name: {
                    "count": int(count),
                    "avg_ms": round(total / count, 2) if count else 0.0,
                }
                for name, (total, count) in self._timings.items()
            }
        return {"counters": counters, "timings": timings}


metrics = Metrics()
