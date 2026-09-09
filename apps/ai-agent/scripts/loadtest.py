"""Gerador de carga para ``POST /webhook/whatsapp``.

Mede o que interessa no endpoint: quantos requests ele aceita e com que latência
— lembrando que a latência inclui o *publisher confirm* do RabbitMQ, que é
justamente a garantia que o ``202`` representa.

    # 500 requests, 50 em paralelo, espalhados por 50 telefones
    python scripts/loadtest.py --total 500 --concurrency 50

    # contenção proposital: tudo no mesmo telefone
    python scripts/loadtest.py --total 200 --concurrency 50 --phones 1

    # payload real da Meta, 5 mensagens por request
    python scripts/loadtest.py --total 100 --batch 5

    # dispara e espera o pipeline drenar, com veredito no fim
    python scripts/loadtest.py --total 500 --wait-drain 90

ATENÇÃO: com os consumers ligados e ``WHATSAPP_PROVIDER=cloud-api``, cada
mensagem processada vira uma chamada real à API da Meta. Rode a carga com
``WHATSAPP_PROVIDER=log``.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import math
import os
import sys
import time
import uuid
from dataclasses import dataclass, field

import httpx

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_URL = "http://localhost:8010/webhook/whatsapp"
DEFAULT_METRICS = "http://localhost:8010/metrics"
DEFAULT_RABBIT_API = "http://localhost:15672/api/queues/%2F"


# ── Resultado ────────────────────────────────────────────────────────────────
@dataclass
class Results:
    latencies: list[float] = field(default_factory=list)
    statuses: dict[int, int] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    published: int = 0

    def record(self, status: int, seconds: float, published: int = 0) -> None:
        self.latencies.append(seconds * 1000)
        self.statuses[status] = self.statuses.get(status, 0) + 1
        self.published += published


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    k = (len(values) - 1) * p
    low, high = math.floor(k), math.ceil(k)
    if low == high:
        return values[int(k)]
    return values[low] + (values[high] - values[low]) * (k - low)


# ── Payloads ─────────────────────────────────────────────────────────────────
TEXTOS = [
    "gastei 47,50 no mercado",
    "paguei 120 de luz",
    "recebi 3000 de salario",
    "almoco 32,90",
    "uber 18,40",
    "farmacia 76,20",
]


def phone_for(index: int, total_phones: int) -> str:
    """Telefones distintos e determinísticos, no formato E.164 brasileiro."""
    return f"+5541{900000000 + (index % max(total_phones, 1)):09d}"


def build_body(run_id: str, index: int, phones: int, batch: int) -> bytes:
    """Payload simplificado (batch=1) ou o formato real da Meta (batch>1)."""
    texto = TEXTOS[index % len(TEXTOS)]
    if batch <= 1:
        payload = {
            "phone": phone_for(index, phones),
            "message": texto,
            "message_id": f"wamid.load-{run_id}-{index}",
            "timestamp": int(time.time()),
        }
        return json.dumps(payload).encode()

    mensagens = []
    for j in range(batch):
        mensagens.append(
            {
                "from": phone_for(index * batch + j, phones).lstrip("+"),
                "id": f"wamid.load-{run_id}-{index}-{j}",
                "type": "text",
                "timestamp": str(int(time.time())),
                "text": {"body": TEXTOS[(index + j) % len(TEXTOS)]},
            }
        )
    payload = {
        "object": "whatsapp_business_account",
        "entry": [{"changes": [{"value": {"messages": mensagens}}]}],
    }
    return json.dumps(payload).encode()


def sign(body: bytes, secret: str) -> dict[str, str]:
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return {"X-Hub-Signature-256": f"sha256={digest}"}


# ── Coleta de estado ─────────────────────────────────────────────────────────
async def fetch_metrics(client: httpx.AsyncClient, url: str) -> dict:
    try:
        response = await client.get(url, timeout=5.0)
        return response.json() if response.status_code == 200 else {}
    except Exception:  # noqa: BLE001 - observabilidade nao pode derrubar o teste
        return {}


async def fetch_queues(client: httpx.AsyncClient, url: str, user: str, password: str) -> dict:
    """Profundidade das filas via API de gerenciamento do RabbitMQ."""
    try:
        response = await client.get(url, auth=(user, password), timeout=5.0)
        if response.status_code != 200:
            return {}
        return {
            q["name"]: {
                "ready": q.get("messages_ready", 0),
                "unacked": q.get("messages_unacknowledged", 0),
                "consumers": q.get("consumers", 0),
            }
            for q in response.json()
            if q["name"].startswith("whatsapp.")
        }
    except Exception:  # noqa: BLE001
        return {}


async def fetch_pending_groups(redis_url: str) -> int | None:
    """Grupos aguardando consolidação (``ZCARD group:due``).

    Estar com as filas vazias **não** significa que o pipeline terminou: as
    mensagens já consumidas ficam no buffer do Redis até o debounce vencer.
    Sem olhar aqui, o dreno declara vitória cedo demais.
    """
    try:
        from redis import asyncio as aioredis
    except ImportError:
        return None

    client = None
    try:
        client = aioredis.from_url(redis_url, encoding="utf-8", decode_responses=True)
        return int(await client.zcard("group:due"))
    except Exception:  # noqa: BLE001
        return None
    finally:
        if client is not None:
            try:
                await client.aclose()
            except Exception:  # noqa: BLE001
                pass


def counter_delta(before: dict, after: dict) -> dict[str, int]:
    antes = (before or {}).get("counters", {})
    depois = (after or {}).get("counters", {})
    return {
        nome: depois.get(nome, 0) - antes.get(nome, 0)
        for nome in sorted(set(antes) | set(depois))
        if depois.get(nome, 0) - antes.get(nome, 0) != 0
    }


# ── Disparo ──────────────────────────────────────────────────────────────────
async def fire(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    url: str,
    body: bytes,
    secret: str | None,
    results: Results,
) -> None:
    headers = {"Content-Type": "application/json"}
    if secret:
        headers.update(sign(body, secret))

    async with semaphore:
        started = time.perf_counter()
        try:
            response = await client.post(url, content=body, headers=headers)
            elapsed = time.perf_counter() - started
            publicadas = 0
            if response.status_code == 202:
                try:
                    publicadas = int(response.json().get("published", 0))
                except Exception:  # noqa: BLE001
                    publicadas = 0
            results.record(response.status_code, elapsed, publicadas)
            if response.status_code >= 400:
                results.errors.append(f"HTTP {response.status_code}: {response.text[:120]}")
        except Exception as exc:  # noqa: BLE001
            results.record(0, time.perf_counter() - started)
            results.errors.append(f"{type(exc).__name__}: {exc}")


async def run_load(args: argparse.Namespace) -> tuple[Results, float]:
    run_id = uuid.uuid4().hex[:8]
    results = Results()
    semaphore = asyncio.Semaphore(args.concurrency)
    limits = httpx.Limits(
        max_connections=args.concurrency + 10, max_keepalive_connections=args.concurrency
    )

    async with httpx.AsyncClient(timeout=args.timeout, limits=limits) as client:
        # Aquece o pool: sem isso, o handshake TCP dos primeiros requests aparece
        # como uma cauda de ~200ms no p99 e é confundido com latência do endpoint.
        if args.warmup:
            descartar = Results()
            await asyncio.gather(
                *[
                    fire(
                        client,
                        semaphore,
                        args.url,
                        build_body(f"warm-{run_id}", i, args.phones, args.batch),
                        args.secret,
                        descartar,
                    )
                    for i in range(args.warmup)
                ]
            )

        tarefas: list[asyncio.Task] = []
        inicio = time.perf_counter()
        intervalo = 1.0 / args.rps if args.rps else 0.0

        for index in range(args.total):
            if intervalo:
                alvo = inicio + index * intervalo
                atraso = alvo - time.perf_counter()
                if atraso > 0:
                    await asyncio.sleep(atraso)
            body = build_body(run_id, index, args.phones, args.batch)
            tarefas.append(
                asyncio.create_task(fire(client, semaphore, args.url, body, args.secret, results))
            )

        await asyncio.gather(*tarefas)
        duracao = time.perf_counter() - inicio

    return results, duracao


# ── Relatório ────────────────────────────────────────────────────────────────
def print_results(args: argparse.Namespace, results: Results, duracao: float) -> None:
    latencias = sorted(results.latencies)
    total = len(latencias)

    print()
    print("=" * 62)
    print("CARGA")
    print("=" * 62)
    print(f"  requests .......... {total}")
    print(f"  concorrência ...... {args.concurrency}")
    print(f"  telefones ......... {args.phones}")
    print(f"  mensagens/request . {args.batch}")
    print(f"  duração ........... {duracao:.2f}s")
    print(f"  throughput ........ {total / duracao:.1f} req/s")
    print(f"  publicadas (202) .. {results.published} mensagens")

    print()
    print("  status:")
    for status, quantidade in sorted(results.statuses.items()):
        rotulo = "erro de conexão" if status == 0 else str(status)
        print(f"    {rotulo:>16} : {quantidade}")

    print()
    print("  latência do webhook (ms) — inclui o publisher confirm:")
    print(f"    {'min':>16} : {latencias[0]:8.1f}")
    print(f"    {'p50':>16} : {percentile(latencias, 0.50):8.1f}")
    print(f"    {'p90':>16} : {percentile(latencias, 0.90):8.1f}")
    print(f"    {'p95':>16} : {percentile(latencias, 0.95):8.1f}")
    print(f"    {'p99':>16} : {percentile(latencias, 0.99):8.1f}")
    print(f"    {'max':>16} : {latencias[-1]:8.1f}")

    if results.errors:
        print()
        print(f"  erros ({len(results.errors)}), primeiros 5:")
        for erro in results.errors[:5]:
            print(f"    - {erro}")


def print_queues(filas: dict) -> None:
    if not filas:
        print("  (API de gerenciamento do RabbitMQ indisponível)")
        return
    print(f"  {'fila':<42} {'ready':>7} {'unacked':>8} {'consumers':>10}")
    for nome in sorted(filas):
        dados = filas[nome]
        if dados["ready"] or dados["unacked"] or "dlq" in nome or nome.endswith(".v1"):
            print(
                f"  {nome:<42} {dados['ready']:>7} {dados['unacked']:>8} {dados['consumers']:>10}"
            )


async def wait_drain(args: argparse.Namespace, segundos: float) -> tuple[dict, int | None]:
    """Espera o pipeline **inteiro** terminar.

    Fila vazia não basta: uma mensagem consumida vai para o buffer de
    agrupamento no Redis e só vira job quando o debounce vence. O dreno termina
    quando as filas estão vazias, não há grupo pendente e todo job publicado já
    foi processado.
    """
    print()
    print("=" * 62)
    print(f"DRENANDO (até {segundos:.0f}s)")
    print("=" * 62)
    principais = (args.inbound_queue, args.processing_queue)

    async with httpx.AsyncClient() as client:
        limite = time.perf_counter() + segundos
        ultimo: dict = {}
        grupos: int | None = None
        while time.perf_counter() < limite:
            ultimo = await fetch_queues(client, args.rabbit_api, args.rabbit_user, args.rabbit_pass)
            pendente = sum(
                ultimo.get(nome, {}).get("ready", 0) + ultimo.get(nome, {}).get("unacked", 0)
                for nome in principais
            )
            grupos = await fetch_pending_groups(args.redis_url)
            metrics = await fetch_metrics(client, args.metrics)
            contadores = metrics.get("counters", {})
            publicados = contadores.get("jobs_published", 0)
            processados = contadores.get("jobs_processed", 0)

            print(
                f"  filas={pendente:<5} grupos={grupos if grupos is not None else '?':<5}"
                f" consumidas={contadores.get('messages_consumed', 0):<7}"
                f" jobs={processados}/{publicados:<6} dlq={contadores.get('dlq_messages', 0)}"
            )

            if pendente == 0 and (grupos or 0) == 0 and processados >= publicados:
                print("  pipeline drenado.")
                break
            await asyncio.sleep(2.0)
        return ultimo, grupos


def veredito(
    args: argparse.Namespace,
    results: Results,
    delta: dict,
    filas: dict,
    grupos: int | None = None,
) -> bool:
    print()
    print("=" * 62)
    print("VEREDITO")
    print("=" * 62)

    checagens: list[tuple[str, bool, str]] = []

    aceitos = results.statuses.get(202, 0)
    checagens.append(
        ("todos os requests aceitos com 202", aceitos == args.total, f"{aceitos}/{args.total}")
    )
    checagens.append(("nenhum 503 (falha de publicação)", results.statuses.get(503, 0) == 0, ""))
    checagens.append(("nenhum erro de conexão", results.statuses.get(0, 0) == 0, ""))

    # O aquecimento também bate no endpoint, então entra na conta do servidor.
    enviados = args.total + args.warmup
    recebidos = delta.get("webhook_received", 0)
    checagens.append(
        ("webhook contabilizou todos", recebidos == enviados, f"{recebidos}/{enviados}")
    )

    confirmadas = delta.get("publish_confirmed", 0)
    esperadas = results.published + args.warmup * max(args.batch, 1)
    checagens.append(
        ("publicações confirmadas", confirmadas == esperadas, f"{confirmadas}/{esperadas}")
    )

    if args.wait_drain:
        pendente = sum(
            filas.get(nome, {}).get("ready", 0) + filas.get(nome, {}).get("unacked", 0)
            for nome in (args.inbound_queue, args.processing_queue)
        )
        checagens.append(("filas principais drenadas", pendente == 0, f"{pendente} pendente(s)"))

        consumidas = delta.get("messages_consumed", 0)
        checagens.append(
            ("todas as mensagens consumidas", consumidas >= esperadas, f"{consumidas}/{esperadas}")
        )

        if grupos is not None:
            checagens.append(
                ("nenhum grupo pendente no Redis", grupos == 0, f"{grupos} aguardando")
            )

        publicados = delta.get("jobs_published", 0)
        processados = delta.get("jobs_processed", 0)
        checagens.append(
            ("todos os jobs processados", processados >= publicados, f"{processados}/{publicados}")
        )

        na_dlq = sum(
            filas.get(nome, {}).get("ready", 0) for nome in filas if nome.endswith(".dlq")
        )
        checagens.append(("DLQ vazia", na_dlq == 0, f"{na_dlq} na DLQ"))

    ok = True
    for descricao, passou, detalhe in checagens:
        marca = "PASS" if passou else "FALHA"
        sufixo = f"  ({detalhe})" if detalhe else ""
        print(f"  [{marca:>5}] {descricao}{sufixo}")
        ok = ok and passou
    return ok


# ── CLI ──────────────────────────────────────────────────────────────────────
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--metrics", default=DEFAULT_METRICS)
    parser.add_argument("--total", type=int, default=200, help="número de requests")
    parser.add_argument("--concurrency", type=int, default=25, help="requests simultâneos")
    parser.add_argument("--phones", type=int, default=50, help="telefones distintos (1 = contenção)")
    parser.add_argument("--batch", type=int, default=1, help=">1 usa o payload da Meta com N mensagens")
    parser.add_argument("--rps", type=float, default=0.0, help="limita a taxa de disparo")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument(
        "--warmup",
        type=int,
        default=20,
        help="requests descartados antes de medir (aquece o pool de conexões)",
    )
    parser.add_argument("--secret", default=os.getenv("WHATSAPP_WEBHOOK_SECRET") or None)
    parser.add_argument("--wait-drain", type=float, default=0.0, help="segundos esperando o pipeline drenar")
    parser.add_argument("--rabbit-api", default=DEFAULT_RABBIT_API)
    parser.add_argument("--rabbit-user", default=os.getenv("RABBITMQ_USER", "guest"))
    parser.add_argument("--rabbit-pass", default=os.getenv("RABBITMQ_PASSWORD", "guest"))
    parser.add_argument("--inbound-queue", default="whatsapp.inbound.v1")
    parser.add_argument("--processing-queue", default="whatsapp.processing.v1")
    parser.add_argument("--redis-url", default=os.getenv("REDIS_URL", "redis://localhost:6379/0"))
    return parser.parse_args()


async def main() -> int:
    args = parse_args()

    async with httpx.AsyncClient() as client:
        antes = await fetch_metrics(client, args.metrics)
        filas_antes = await fetch_queues(client, args.rabbit_api, args.rabbit_user, args.rabbit_pass)

    if not antes:
        print(f"AVISO: /metrics indisponível em {args.metrics}; o agente está no ar?")
    if filas_antes:
        print("Filas antes:")
        print_queues(filas_antes)

    print(f"\nDisparando {args.total} requests ({args.concurrency} em paralelo)...")
    results, duracao = await run_load(args)
    print_results(args, results, duracao)

    filas: dict = {}
    grupos: int | None = None
    if args.wait_drain:
        filas, grupos = await wait_drain(args, args.wait_drain)

    async with httpx.AsyncClient() as client:
        depois = await fetch_metrics(client, args.metrics)
        if not filas:
            filas = await fetch_queues(client, args.rabbit_api, args.rabbit_user, args.rabbit_pass)

    delta = counter_delta(antes, depois)
    print()
    print("=" * 62)
    print("MÉTRICAS (delta)")
    print("=" * 62)
    for nome, valor in delta.items():
        print(f"  {nome:<32} {valor:>8}")
    for nome, dados in (depois.get("timings") or {}).items():
        print(f"  {nome:<32} {dados['avg_ms']:>8} ms (média de {dados['count']})")

    print()
    print("=" * 62)
    print("FILAS")
    print("=" * 62)
    print_queues(filas)

    return 0 if veredito(args, results, delta, filas, grupos) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
