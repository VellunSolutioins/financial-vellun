"""Métricas do agente: exposição Prometheus e compatibilidade do shape antigo.

A migração de ``/metrics`` para texto Prometheus tem consumidores reais
(``scripts/monitor.py`` e ``scripts/loadtest.py``), então o shape
``{counters, timings}`` precisa continuar íntegro em ``/metrics.json``.
"""

from __future__ import annotations

import pytest
from prometheus_client import CollectorRegistry

from src.services.metrics import (
    KNOWN_COUNTERS,
    KNOWN_TIMINGS,
    Metrics,
    _counter_name,
    _timing_name,
)


@pytest.fixture
def metrics() -> Metrics:
    # Registro próprio: o singleton do módulo é compartilhado e vazaria entre testes.
    return Metrics(registry=CollectorRegistry())


# ── Nomes e unidades ─────────────────────────────────────────────────────────
def test_contador_recebe_sufixo_total():
    assert _counter_name("messages_consumed") == "vellun_agent_messages_consumed_total"


def test_latencia_em_ms_e_exportada_como_segundos():
    # A convenção do Prometheus é segundo. Um histograma em ms com nome
    # `_seconds` produz dashboard errado por três ordens de grandeza.
    assert _timing_name("llm_latency_ms") == "vellun_agent_llm_latency_seconds"
    assert _timing_name("processing_duration_ms") == "vellun_agent_processing_duration_seconds"


def test_nome_nao_declarado_ainda_perde_o_sufixo_ms():
    assert _timing_name("algo_novo_ms") == "vellun_agent_algo_novo_seconds"


# ── Exposição Prometheus ─────────────────────────────────────────────────────
def test_render_devolve_texto_prometheus(metrics: Metrics):
    metrics.incr("messages_consumed", 3)
    body, content_type = metrics.render()
    texto = body.decode()

    assert "text/plain" in content_type
    assert "# HELP vellun_agent_messages_consumed_total" in texto
    assert "# TYPE vellun_agent_messages_consumed_total counter" in texto
    assert "vellun_agent_messages_consumed_total 3.0" in texto


def test_contadores_conhecidos_existem_zerados(metrics: Metrics):
    """Série que só nasce na primeira ocorrência não é alertável.

    Sem declaração, `rate(...)` e `absent(...)` responderiam "sem dado" em vez de
    "zero" — e o alerta de "nova entrada em DLQ" nunca teria uma linha de base.
    """
    texto = metrics.render()[0].decode()

    assert "vellun_agent_dlq_total 0.0" in texto
    assert "vellun_agent_processing_error_total 0.0" in texto
    # Todos os declarados aparecem, não só os exercitados.
    for nome in KNOWN_COUNTERS:
        assert _counter_name(nome) in texto


def test_histogramas_conhecidos_existem_zerados(metrics: Metrics):
    texto = metrics.render()[0].decode()

    for nome in KNOWN_TIMINGS:
        assert f"{_timing_name(nome)}_count 0.0" in texto


def test_observe_ms_converte_para_segundos(metrics: Metrics):
    metrics.observe_ms("llm_latency_ms", 2500)
    texto = metrics.render()[0].decode()

    assert "vellun_agent_llm_latency_seconds_sum 2.5" in texto
    assert "vellun_agent_llm_latency_seconds_count 1.0" in texto


def test_contador_nao_declarado_e_criado_sob_demanda(metrics: Metrics):
    # Esquecer um nome em KNOWN_COUNTERS não deve perder o dado. O nome vem
    # sempre do código, então não há risco de explosão de séries.
    metrics.incr("metrica_nova_qualquer")
    metrics.incr("metrica_nova_qualquer")

    assert "vellun_agent_metrica_nova_qualquer_total 2.0" in metrics.render()[0].decode()


def test_nenhuma_metrica_usa_label(metrics: Metrics):
    """Regra de cardinalidade: identificador vai para o log, nunca para label.

    Um label livre cria uma série por valor distinto e estoura o limite de séries
    ativas do free tier — e a conta passa a cobrar ou a descartar em silêncio.
    """
    for metric in metrics.registry.collect():
        for sample in metric.samples:
            # `le` é do próprio histograma do Prometheus, não é dado nosso.
            assert set(sample.labels) <= {"le"}, f"{sample.name} tem label {sample.labels}"


# ── Shape legado ─────────────────────────────────────────────────────────────
def test_snapshot_preserva_o_shape_antigo(metrics: Metrics):
    metrics.incr("webhook_received", 5)
    metrics.observe_ms("webhook_latency_ms", 40)
    metrics.observe_ms("webhook_latency_ms", 60)

    snapshot = metrics.snapshot()

    assert snapshot["counters"]["webhook_received"] == 5
    # A média volta em milissegundos: é a unidade que os scripts imprimem.
    assert snapshot["timings"]["webhook_latency_ms"] == {"count": 2, "avg_ms": 50.0}


def test_snapshot_traz_zero_e_nao_omite_o_que_nunca_ocorreu(metrics: Metrics):
    snapshot = metrics.snapshot()

    assert snapshot["counters"]["dlq"] == 0
    assert snapshot["timings"]["llm_latency_ms"] == {"count": 0, "avg_ms": 0.0}


def test_snapshot_e_derivado_do_registro(metrics: Metrics):
    """As duas exposições leem a mesma fonte, então não podem divergir.

    Com dois conjuntos de contadores em paralelo, a exposição que os scripts leem
    seria a que menos alguém conferiria.
    """
    metrics.incr("jobs_processed", 7)

    texto = metrics.render()[0].decode()
    assert "vellun_agent_jobs_processed_total 7.0" in texto
    assert metrics.snapshot()["counters"]["jobs_processed"] == 7
