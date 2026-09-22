"""Métricas de capacidade e SLO (P4 do plano de performance).

Três coisas que só um teste segura:

1. **nome de rota vem de conjunto fechado** — um telefone ou uuid num *nome* de
   métrica é pior que num label: cria uma série por valor e não dá para filtrar
   depois;
2. **o contador de DLQ existe** — os scripts liam `dlq_messages`, que nunca
   existiu, e reportavam zero para sempre;
3. **a latência fim a fim é medida na saída** — é a única que inclui tempo de
   fila, e portanto a única que corresponde ao que o usuário sente.
"""

from __future__ import annotations

import pytest

from src.consumers.outbound_consumer import OutboundMessageConsumer
from src.messaging.base import ROUTE_OUTBOUND, BrokerMessage, PermanentError, dispatch
from src.messaging.contracts import OutboundMessageV1, utcnow
from src.services.api_client import route_slug
from src.services.metrics import Metrics


class FakeMessenger:
    def __init__(self) -> None:
        self.enviadas: list[tuple[str, str]] = []

    async def send(self, phone: str, text: str) -> None:
        self.enviadas.append((phone, text))


@pytest.fixture
def whatsapp(monkeypatch):
    fake = FakeMessenger()
    import src.services.message_processor as mp

    monkeypatch.setattr(mp, "messenger", fake)

    class SemAuditoria:
        async def log_message(self, *args, **kwargs):
            return None

    monkeypatch.setattr(mp, "audit_service", SemAuditoria())
    return fake


class TestRotaAgregada:
    @pytest.mark.parametrize(
        "caminho,esperado",
        [
            ("/internal/users/2b1f8c4e-1234-4aaa-9bbb-0001/categories", "users_categories"),
            ("/internal/users/2b1f8c4e-1234-4aaa-9bbb-0001/accounts", "users_accounts"),
            (
                "/internal/users/2b1f8c4e/subscription-access",
                "users_subscription_access",
            ),
            ("/internal/whatsapp/contacts/%2B5541999999999", "whatsapp_contact"),
            (
                "/internal/whatsapp/contacts/%2B5541999999999/messages",
                "whatsapp_contact_messages",
            ),
            ("/internal/transactions/from-ai", "transactions_from_ai"),
            ("/internal/ai-events", "ai_events"),
        ],
    )
    def test_identificador_nunca_entra_no_nome(self, caminho, esperado):
        assert route_slug(caminho) == esperado

    def test_rota_desconhecida_cai_em_outra(self):
        # Não inventa um nome a partir do caminho: um endpoint novo aparece como
        # `outra` no dashboard, que é o sinal de que a allowlist ficou para trás.
        assert route_slug("/internal/endpoint/que/ainda/nao/existe") == "outra"

    def test_nenhum_nome_carrega_telefone_ou_uuid(self):
        suspeitos = ("5541", "%2B", "2b1f8c4e", "-")
        caminhos = [
            "/internal/whatsapp/contacts/%2B5541999999999",
            "/internal/users/2b1f8c4e-1234-4aaa-9bbb-0001/categories",
            "/internal/qualquer/coisa/5541999999999",
        ]
        for caminho in caminhos:
            nome = route_slug(caminho)
            assert not any(s in nome for s in suspeitos), nome


class TestContadorDeDlq:
    async def test_falha_permanente_conta_na_dlq(self):
        colhido = Metrics()

        async def handler(_):
            raise PermanentError("contrato inválido")

        async def nada(*args, **kwargs):
            return None

        import src.messaging.base as base

        original = base.metrics
        base.metrics = colhido
        try:
            resultado = await dispatch(
                BrokerMessage(body=b"{}", routing_key="x"),
                handler,
                max_retries=3,
                on_retry=nada,
                on_dlq=nada,
            )
        finally:
            base.metrics = original

        assert resultado == "dlq"
        # É este nome que `monitor.py` e `loadtest.py` leem agora.
        assert colhido.snapshot()["counters"]["dlq"] == 1

    async def test_tentativas_esgotadas_tambem_contam(self):
        colhido = Metrics()

        async def handler(_):
            raise RuntimeError("API fora")

        async def nada(*args, **kwargs):
            return None

        import src.messaging.base as base

        original = base.metrics
        base.metrics = colhido
        try:
            # `attempt` na última tentativa possível: o próximo destino é a DLQ.
            await dispatch(
                BrokerMessage(body=b"{}", routing_key="x", attempt=2),
                handler,
                max_retries=3,
                on_retry=nada,
                on_dlq=nada,
            )
        finally:
            base.metrics = original

        assert colhido.snapshot()["counters"]["dlq"] == 1


class TestLatenciaFimAFim:
    async def test_medida_na_entrega_com_o_instante_do_webhook(self, whatsapp):
        from src.services.metrics import metrics

        antes = metrics.snapshot()["timings"]["message_end_to_end_ms"]["count"]

        payload = OutboundMessageV1(
            phone="+5541999999999",
            text="Lançamento criado!",
            job_id="job-latencia",
            first_received_at=utcnow(),
        )
        await OutboundMessageConsumer().handle(
            BrokerMessage(
                body=payload.model_dump_json(by_alias=True).encode(),
                routing_key=ROUTE_OUTBOUND,
            )
        )

        depois = metrics.snapshot()["timings"]["message_end_to_end_ms"]["count"]
        assert depois == antes + 1

    async def test_sem_o_instante_nao_inventa_medida(self, whatsapp):
        """Aviso solto não tem origem no webhook; medir zero sujaria o p95."""
        from src.services.metrics import metrics

        antes = metrics.snapshot()["timings"]["message_end_to_end_ms"]["count"]

        payload = OutboundMessageV1(phone="+5541999999999", text="Número não vinculado.")
        await OutboundMessageConsumer().handle(
            BrokerMessage(
                body=payload.model_dump_json(by_alias=True).encode(),
                routing_key=ROUTE_OUTBOUND,
            )
        )

        assert metrics.snapshot()["timings"]["message_end_to_end_ms"]["count"] == antes
