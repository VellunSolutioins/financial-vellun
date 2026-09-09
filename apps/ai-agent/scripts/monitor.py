"""Monitor ao vivo do pipeline de mensageria.

Imprime uma linha por intervalo com o que está entrando, o que está sendo
consumido e o tamanho das filas — para acompanhar em um segundo terminal
enquanto o ``loadtest.py`` dispara.

    python scripts/monitor.py
    python scripts/monitor.py --interval 2

As colunas ``/s`` são a variação desde a linha anterior, então dá para ver a
taxa de entrada (``in/s``) e a de consumo (``cons/s``) divergirem quando o
backlog cresce.

Contadores vêm de ``GET /metrics``, que é **por processo**: com
``RUN_CONSUMERS_IN_API=false``, as colunas de consumo ficam zeradas aqui e o que
vale é a profundidade das filas.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time

import httpx

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_METRICS = "http://localhost:8010/metrics"
DEFAULT_READY = "http://localhost:8010/health/ready"
DEFAULT_RABBIT_API = "http://localhost:15672/api/queues/%2F"

COLUNAS = (
    f"{'hora':<8} {'recv':>7} {'in/s':>7} {'conf':>7} {'falha':>6} "
    f"{'cons':>7} {'cons/s':>7} {'jobs':>6} {'dup':>5} {'defer':>6} {'dlq':>5} "
    f"{'q:inb':>7} {'q:proc':>7} {'lat_ms':>8}"
)


async def coletar(client: httpx.AsyncClient, args: argparse.Namespace) -> dict:
    estado: dict = {"counters": {}, "timings": {}, "filas": {}, "ready": "?"}

    try:
        resposta = await client.get(args.metrics, timeout=5.0)
        if resposta.status_code == 200:
            dados = resposta.json()
            estado["counters"] = dados.get("counters", {})
            estado["timings"] = dados.get("timings", {})
    except Exception:  # noqa: BLE001 - monitor nao pode derrubar nada
        pass

    try:
        resposta = await client.get(args.ready, timeout=5.0)
        estado["ready"] = "ok" if resposta.status_code == 200 else f"{resposta.status_code}"
    except Exception:  # noqa: BLE001
        estado["ready"] = "fora"

    try:
        resposta = await client.get(
            args.rabbit_api, auth=(args.rabbit_user, args.rabbit_pass), timeout=5.0
        )
        if resposta.status_code == 200:
            estado["filas"] = {
                q["name"]: q.get("messages_ready", 0) + q.get("messages_unacknowledged", 0)
                for q in resposta.json()
                if q["name"].startswith("whatsapp.")
            }
    except Exception:  # noqa: BLE001
        pass

    return estado


def formatar(estado: dict, anterior: dict | None, intervalo: float, args) -> str:
    contadores = estado["counters"]
    antes = (anterior or {}).get("counters", {})

    def valor(nome: str) -> int:
        return int(contadores.get(nome, 0))

    def taxa(nome: str) -> float:
        return (valor(nome) - int(antes.get(nome, 0))) / intervalo if anterior else 0.0

    filas = estado["filas"]
    latencia = (estado["timings"].get("webhook_latency_ms") or {}).get("avg_ms", 0.0)

    return (
        f"{time.strftime('%H:%M:%S'):<8} "
        f"{valor('webhook_received'):>7} {taxa('webhook_received'):>7.1f} "
        f"{valor('publish_confirmed'):>7} {valor('publish_failed'):>6} "
        f"{valor('messages_consumed'):>7} {taxa('messages_consumed'):>7.1f} "
        f"{valor('jobs_processed'):>6} {valor('jobs_duplicated'):>5} "
        f"{valor('jobs_deferred'):>6} {valor('dlq_messages'):>5} "
        f"{filas.get(args.inbound_queue, 0):>7} {filas.get(args.processing_queue, 0):>7} "
        f"{latencia:>8.1f}"
    )


def resumo_dlq(estado: dict) -> str | None:
    presas = {
        nome: qtd for nome, qtd in estado["filas"].items() if nome.endswith(".dlq") and qtd
    }
    if not presas:
        return None
    return "  DLQ: " + ", ".join(f"{nome}={qtd}" for nome, qtd in sorted(presas.items()))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--metrics", default=DEFAULT_METRICS)
    parser.add_argument("--ready", default=DEFAULT_READY)
    parser.add_argument("--rabbit-api", default=DEFAULT_RABBIT_API)
    parser.add_argument("--rabbit-user", default=os.getenv("RABBITMQ_USER", "guest"))
    parser.add_argument("--rabbit-pass", default=os.getenv("RABBITMQ_PASSWORD", "guest"))
    parser.add_argument("--inbound-queue", default="whatsapp.inbound.v1")
    parser.add_argument("--processing-queue", default="whatsapp.processing.v1")
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--count", type=int, default=0, help="0 = até Ctrl+C")
    return parser.parse_args()


async def main() -> int:
    args = parse_args()
    print(f"Monitorando {args.metrics} (Ctrl+C para sair)\n")

    anterior: dict | None = None
    linhas = 0

    async with httpx.AsyncClient() as client:
        while args.count == 0 or linhas < args.count:
            estado = await coletar(client, args)

            if linhas % 20 == 0:
                print(COLUNAS)
                print("-" * len(COLUNAS))

            print(formatar(estado, anterior, args.interval, args))
            alerta = resumo_dlq(estado)
            if alerta:
                print(alerta)
            if estado["ready"] != "ok":
                print(f"  readiness: {estado['ready']}")

            anterior = estado
            linhas += 1
            await asyncio.sleep(args.interval)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\nencerrado")
