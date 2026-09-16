"""Métricas do agente, expostas em formato Prometheus.

Duas exposições, de propósito:

- ``GET /metrics``      texto Prometheus, é o que o Alloy coleta;
- ``GET /metrics.json`` o shape antigo (``{counters, timings}``), preservado
  porque ``scripts/monitor.py`` e ``scripts/loadtest.py`` dependem dele.

A API interna (``incr`` / ``observe_ms``) continua a mesma para que os cerca de
trinta pontos de instrumentação já existentes não precisassem ser reescritos.

**Nada de identificador vira label.** ``correlationId``, ``jobId``, telefone,
e-mail e conteúdo de mensagem vão para o log, nunca para cá: um label livre cria
uma série por valor distinto e estoura o limite de séries ativas do free tier —
e aí a conta passa a cobrar ou a descartar dado, em silêncio. O que varia por
categoria (o tipo de mídia, por exemplo) vira **nome** de métrica, que é um
conjunto fechado definido no código.
"""

from __future__ import annotations

import threading

from prometheus_client import CollectorRegistry, Counter, Histogram, generate_latest
from prometheus_client.exposition import CONTENT_TYPE_LATEST

#: Prefixo de todas as métricas do agente.
NAMESPACE = "vellun_agent"

#: Faixas em **segundos**, cobrindo de webhook (dezenas de ms) a fluxo completo
#: de recebimento a processamento (dezenas de segundos). Um conjunto único mantém
#: os dashboards comparáveis entre as etapas.
DURATION_BUCKETS = (
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    30.0,
    60.0,
)

#: Contadores declarados na inicialização.
#:
#: Declarar em vez de criar sob demanda importa para alerta: uma série que só
#: nasce na primeira ocorrência faz ``rate(...)`` e ``absent(...)`` responderem
#: "sem dado" em vez de "zero", e é impossível alertar sobre algo que nunca
#: apareceu. Com a declaração, "nenhuma DLQ hoje" é um zero legítimo.
KNOWN_COUNTERS = (
    # Webhook
    "webhook_received",
    "webhook_ignored",
    "webhook_invalid_signature",
    "webhook_text_too_long",
    "webhook_invalid_item",
    "publish_confirmed",
    "publish_failed",
    # Consumo de entrada
    "messages_consumed",
    "messages_duplicated",
    "inbound_grouped",
    "inbound_group_deduplicated",
    "inbound_buffered",
    "inbound_duplicate",
    "not_linked",
    "message_too_long",
    "subscription_blocked",
    # Mídia
    "media_audio",
    "media_image",
    "media_unsupported",
    "transcription_success",
    "transcription_fail",
    "vision_success",
    "vision_fail",
    # Agrupamento
    "group_flushed",
    "group_flush_failed",
    "buffer_flush",
    "group_lock_lost",
    # Processamento
    "jobs_published",
    "jobs_processed",
    "jobs_duplicated",
    "jobs_deferred",
    "messages_processed",
    "processing_error",
    "confirmation_requested",
    "processing_lock_lost",
    # LLM e efeitos
    "llm_success",
    "llm_fallback",
    "transactions_created",
    "transactions_idempotent_hit",
    "extractions_idempotent_hit",
    "whatsapp_send_failed",
    "jobs_reply_resumed",
    # Falha definitiva
    "dlq",
    # Catalogo de falhas (Entrega 5): a DLQ e transporte, o Postgres e a fonte
    # de verdade. `captured` e o par que o dashboard compara com a profundidade
    # da DLQ para expor divergencia.
    "dlq_catalog_captured",
    "dlq_catalog_duplicated",
    "dlq_catalog_failed",
    "dlq_catalog_invalid_envelope",
    # Aviso ao usuário cuja mensagem caiu na DLQ: sem ele, a falha era silêncio.
    "dlq_user_notified",
    "dlq_user_notice_suppressed",
    "dlq_user_notice_failed",
    # Reprocessamento pedido pelo painel de operacoes
    "ops_reprocess_published",
    "ops_reprocess_publish_failed",
)

#: Histogramas declarados na inicialização. A chave é o nome usado em
#: ``observe_ms``; o valor, o nome da métrica exportada (em segundos).
KNOWN_TIMINGS = {
    "webhook_latency_ms": "webhook_latency_seconds",
    "llm_latency_ms": "llm_latency_seconds",
    "processing_duration_ms": "processing_duration_seconds",
    "receive_to_process_ms": "receive_to_process_seconds",
}


def _counter_name(name: str) -> str:
    """``messages_consumed`` → ``vellun_agent_messages_consumed_total``."""
    return f"{NAMESPACE}_{name}_total"


def _timing_name(name: str) -> str:
    """``llm_latency_ms`` → ``vellun_agent_llm_latency_seconds``.

    A conversão de unidade é obrigatória, não cosmética: a convenção do
    Prometheus é segundo, e um histograma em milissegundos com nome ``_seconds``
    (ou vice-versa) produz dashboard errado por três ordens de grandeza.
    """
    exported = KNOWN_TIMINGS.get(name)
    if exported is not None:
        return f"{NAMESPACE}_{exported}"
    base = name[:-3] if name.endswith("_ms") else name
    return f"{NAMESPACE}_{base}_seconds"


class Metrics:
    """Coletor do agente. Um por processo."""

    def __init__(self, registry: CollectorRegistry | None = None) -> None:
        self._lock = threading.Lock()
        self.registry = registry if registry is not None else CollectorRegistry()
        self._counters: dict[str, Counter] = {}
        self._histograms: dict[str, Histogram] = {}
        self._declare_known()

    def _declare_known(self) -> None:
        for name in KNOWN_COUNTERS:
            self._counters[name] = Counter(
                _counter_name(name),
                f"Ocorrências de {name.replace('_', ' ')}.",
                registry=self.registry,
            )
        for name in KNOWN_TIMINGS:
            self._histograms[name] = Histogram(
                _timing_name(name),
                f"Duração de {name.removesuffix('_ms').replace('_', ' ')} em segundos.",
                buckets=DURATION_BUCKETS,
                registry=self.registry,
            )

    # ── Escrita ─────────────────────────────────────────────────────────────
    def incr(self, name: str, amount: int = 1) -> None:
        self._counter(name).inc(amount)

    def observe_ms(self, name: str, value_ms: float) -> None:
        """Registra uma duração dada em **milissegundos**.

        A assinatura mantém milissegundos porque é o que os chamadores já medem;
        a conversão para segundos acontece aqui, num só lugar.
        """
        self._histogram(name).observe(value_ms / 1000.0)

    def _counter(self, name: str) -> Counter:
        existing = self._counters.get(name)
        if existing is not None:
            return existing

        # Contador não declarado: cria mesmo assim, para não perder o dado por
        # causa de um esquecimento em KNOWN_COUNTERS. O nome vem do código (é
        # sempre literal ou de um conjunto fechado), então não há risco de
        # explosão de séries.
        with self._lock:
            existing = self._counters.get(name)
            if existing is None:
                existing = Counter(
                    _counter_name(name),
                    f"Ocorrências de {name.replace('_', ' ')}.",
                    registry=self.registry,
                )
                self._counters[name] = existing
        return existing

    def _histogram(self, name: str) -> Histogram:
        existing = self._histograms.get(name)
        if existing is not None:
            return existing

        with self._lock:
            existing = self._histograms.get(name)
            if existing is None:
                existing = Histogram(
                    _timing_name(name),
                    f"Duração de {name.removesuffix('_ms').replace('_', ' ')} em segundos.",
                    buckets=DURATION_BUCKETS,
                    registry=self.registry,
                )
                self._histograms[name] = existing
        return existing

    # ── Leitura ─────────────────────────────────────────────────────────────
    def render(self) -> tuple[bytes, str]:
        """Exposição Prometheus: corpo e ``Content-Type``."""
        return generate_latest(self.registry), CONTENT_TYPE_LATEST

    def snapshot(self) -> dict:
        """Shape legado ``{counters, timings}``, para ``/metrics.json``.

        Deriva os valores do **próprio registro** em vez de manter um segundo
        conjunto de contadores em paralelo. Com dois conjuntos, as duas
        exposições poderiam divergir — e a que os scripts leem é a que menos
        alguém conferiria.
        """
        totals: dict[str, float] = {}
        sums: dict[str, float] = {}
        counts: dict[str, float] = {}

        # Nenhuma métrica do agente usa label, então cada nome de amostra aparece
        # uma vez e a atribuição direta basta.
        for metric in self.registry.collect():
            for sample in metric.samples:
                totals[sample.name] = sample.value
                if sample.name.endswith("_sum"):
                    sums[sample.name[: -len("_sum")]] = sample.value
                elif sample.name.endswith("_count"):
                    counts[sample.name[: -len("_count")]] = sample.value

        counters = {
            name: int(totals.get(_counter_name(name), 0.0)) for name in self._counters
        }

        timings = {}
        for name in self._histograms:
            exported = _timing_name(name)
            count = counts.get(exported, 0.0)
            total_seconds = sums.get(exported, 0.0)
            timings[name] = {
                "count": int(count),
                # Volta para milissegundos: é a unidade que os scripts imprimem.
                "avg_ms": round((total_seconds / count) * 1000, 2) if count else 0.0,
            }

        return {"counters": counters, "timings": timings}


metrics = Metrics()
