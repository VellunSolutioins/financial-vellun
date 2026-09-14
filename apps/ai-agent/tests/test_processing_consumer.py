"""Consumer de processamento: idempotência, ordenação e concorrência.

Cobre os casos obrigatórios:

8.  reenvio não cria uma segunda transação;
13. telefones diferentes são processados em paralelo;
14. mensagens do mesmo telefone não são processadas fora de ordem;
16. timeout depois da criação da transação não gera duplicidade;
19. conta ou categoria de outro usuário continua sendo rejeitada;
20. usuário sem assinatura não chama LLM nem cria lançamento.
"""

from __future__ import annotations

import asyncio

import pytest

from src.consumers import MessageProcessingConsumer
from src.consumers.processing_consumer import done_key, lock_key
from src.messaging.base import ROUTE_PROCESSING
from src.messaging.contracts import ProcessingJobV1, derive_job_id
from src.schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum
from src.services.distributed_state import get_state_store

PHONE = "+5541999999999"


class Recorder:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.sent: list[str] = []
        self.created: dict[str, dict] = {}
        self.extractions: dict[str, str] = {}
        self.extraction_duplicates = 0
        self.llm_calls = 0
        self.linked: list[str | None] = []


def make_job(text: str = "gastei 47,50 no mercado", **kwargs) -> ProcessingJobV1:
    source_ids = kwargs.pop("source_message_ids", ["ai-1"])
    return ProcessingJobV1(
        job_id=derive_job_id(
            phone=kwargs.get("phone", PHONE),
            source_message_ids=source_ids,
            provider_message_ids=[],
        ),
        phone=kwargs.pop("phone", PHONE),
        combined_message=text,
        source_message_ids=source_ids,
        **kwargs,
    )


@pytest.fixture
def env(monkeypatch):
    """Substitui as dependências externas do MessageProcessor."""
    import src.services.message_processor as mp

    rec = Recorder()

    class FakeContact:
        async def find_by_phone(self, phone):
            rec.calls.append("contact")
            return {"userId": "u1", "profileType": "personal"}

    class FakeGate:
        allowed = True
        message: str | None = None

        async def evaluate(self, user_id):
            rec.calls.append("gate")
            return self.allowed, self.message

    class FakeClassifier:
        async def classify(self, message, context):
            rec.calls.append("classify")
            rec.llm_calls += 1
            return FinancialIntent(
                intent=IntentType.create_transaction,
                transaction_type=TransactionTypeEnum.expense,
                amount=47.5,
                description="mercado",
                category_name="Mercado",
                transaction_date="2026-09-05",
                confidence=0.95,
                needs_confirmation=False,
            )

        def classify_with_rules(self, message, context=None):
            return FinancialIntent(intent=IntentType.confirmation_reply, confidence=0.5)

    class FakeAudit:
        """Simula a idempotência real de `POST /internal/ai-events`."""

        async def log_extraction(self, **kwargs):
            rec.calls.append("log_extraction")
            key = kwargs.get("idempotency_key")
            if key and key in rec.extractions:
                rec.extraction_duplicates += 1
                return rec.extractions[key]
            extraction_id = f"ext-{len(rec.extractions) + 1}"
            if key:
                rec.extractions[key] = extraction_id
            return extraction_id

        async def log_message(self, *args, **kwargs):
            return "outbound-1"

    class FakeTxCreator:
        """Simula a idempotência real da API: mesma chave, mesma transação."""

        fail_after_create = False

        async def create_from_intent(
            self, intent, user_id, raw, ai_extracted_transaction_id=None, idempotency_key=None
        ):
            rec.calls.append("create")
            rec.linked.append(ai_extracted_transaction_id)
            if idempotency_key and idempotency_key in rec.created:
                return {
                    "ok": True,
                    "message": "Lançamento criado!",
                    "transaction": {**rec.created[idempotency_key], "idempotent": True},
                }
            transaction = {"id": f"tx-{len(rec.created) + 1}", "amount": intent.amount}
            if idempotency_key:
                rec.created[idempotency_key] = transaction
            if self.fail_after_create:
                # Timeout depois de a API já ter gravado o lançamento.
                raise TimeoutError("resposta perdida após a criação")
            return {"ok": True, "message": "Lançamento criado!", "transaction": transaction}

    class FakeMessenger:
        async def send(self, phone, text):
            rec.sent.append(text)

    async def fake_build_context(self, user_id, contact, phone):
        rec.calls.append("build_context")
        return {"categories": ["Mercado"], "accounts": ["Carteira"], "recent_messages": []}

    gate = FakeGate()
    creator = FakeTxCreator()
    monkeypatch.setattr(mp, "contact_service", FakeContact())
    monkeypatch.setattr(mp, "subscription_gate", gate)
    monkeypatch.setattr(mp, "intent_classifier", FakeClassifier())
    monkeypatch.setattr(mp, "audit_service", FakeAudit())
    monkeypatch.setattr(mp, "transaction_creator", creator)
    monkeypatch.setattr(mp, "messenger", FakeMessenger())
    monkeypatch.setattr(mp.MessageProcessor, "_build_context", fake_build_context)

    rec.gate = gate  # type: ignore[attr-defined]
    rec.creator = creator  # type: ignore[attr-defined]
    return rec


@pytest.fixture
def consumer(broker):
    instance = MessageProcessingConsumer()
    broker.register(ROUTE_PROCESSING, instance.handle)
    return instance


async def publish_job(broker, job: ProcessingJobV1) -> None:
    await broker.publish_body(
        ROUTE_PROCESSING, job.model_dump_json(by_alias=True).encode()
    )


# ── Caminho feliz ────────────────────────────────────────────────────────────
async def test_processa_job_e_cria_lancamento(broker, consumer, env):
    await publish_job(broker, make_job())
    await broker.drain()

    assert env.calls == ["contact", "gate", "build_context", "classify", "log_extraction", "create"]
    assert env.sent == ["Lançamento criado!"]
    assert len(broker.acked) == 1


async def test_lock_do_telefone_e_liberado_ao_final(broker, consumer, env):
    await publish_job(broker, make_job())
    await broker.drain()

    assert await get_state_store().exists(lock_key(PHONE)) is False


# ── Idempotência (casos 8 e 16) ──────────────────────────────────────────────
async def test_reentrega_do_mesmo_job_nao_cria_segunda_transacao(broker, consumer, env):
    job = make_job()
    await publish_job(broker, job)
    await publish_job(broker, job)
    await broker.drain()

    assert env.calls.count("create") == 1
    assert len(broker.acked) == 2
    assert await get_state_store().exists(done_key(job.job_id)) is True


async def test_timeout_apos_criacao_nao_duplica_lancamento(broker, consumer, env):
    """A criação teve êxito, mas a resposta se perdeu: o retry reusa a chave."""
    job = make_job()
    env.creator.fail_after_create = True

    await publish_job(broker, job)
    await broker._dispatch(broker.queues[ROUTE_PROCESSING].popleft(), consumer.handle)

    assert len(broker.retried) == 1
    assert len(env.created) == 1  # a transação existe no "banco"

    # O retry chega com o mesmo jobId; a API devolve a existente.
    env.creator.fail_after_create = False
    await broker.drain()

    assert len(env.created) == 1
    assert env.calls.count("create") == 2  # duas chamadas, um único lançamento


async def test_job_id_e_a_chave_de_idempotencia_enviada_a_api(broker, consumer, env):
    job = make_job()
    await publish_job(broker, job)
    await broker.drain()

    assert list(env.created.keys()) == [job.job_id]


# ── Ordenação e concorrência (casos 13 e 14) ─────────────────────────────────
async def test_telefones_diferentes_sao_processados_em_paralelo(broker, consumer, env):
    outro = "+5511888887777"
    ordem: list[str] = []

    import src.services.message_processor as mp

    original = mp.MessageProcessor.process_job

    async def slow(self, job):
        ordem.append(f"inicio:{job.phone}")
        await asyncio.sleep(0.02)
        ordem.append(f"fim:{job.phone}")
        return await original(self, job)

    mp.MessageProcessor.process_job = slow
    try:
        await asyncio.gather(
            consumer.handle(_broker_message(make_job(source_message_ids=["ai-1"]))),
            consumer.handle(
                _broker_message(make_job(phone=outro, source_message_ids=["ai-2"]))
            ),
        )
    finally:
        mp.MessageProcessor.process_job = original

    # Interleaved: nenhum telefone esperou o outro terminar.
    assert ordem[0].startswith("inicio")
    assert ordem[1].startswith("inicio")


async def test_mesmo_telefone_nao_processa_fora_de_ordem(broker, consumer, env):
    """O segundo job do mesmo telefone é adiado enquanto o primeiro roda."""
    store = get_state_store()
    # Simula o primeiro job ainda em processamento (lock tomado).
    token = await store.acquire(lock_key(PHONE), 60)
    assert token is not None

    await publish_job(broker, make_job(source_message_ids=["ai-2"]))
    await broker._dispatch(broker.queues[ROUTE_PROCESSING].popleft(), consumer.handle)

    # Nada foi processado e o job voltou para a fila sem consumir tentativa.
    assert env.calls == []
    assert len(broker.retried) == 1
    assert broker.retried[0].attempt == 0
    assert broker.retried[0].headers["x-defer-count"] == 1

    assert await store.release(lock_key(PHONE), token) is True
    await broker.drain()
    assert env.calls.count("create") == 1


async def test_adiamento_excessivo_deixa_de_ser_infinito(broker, consumer, env):
    """Um lock preso não pode adiar para sempre: vira falha e caminha para a DLQ."""
    from src.consumers.processing_consumer import MAX_DEFERS
    from src.messaging.base import BrokerMessage

    await get_state_store().acquire(lock_key(PHONE), 60)
    job = make_job()
    message = BrokerMessage(
        body=job.model_dump_json(by_alias=True).encode(),
        routing_key=ROUTE_PROCESSING,
        headers={"x-defer-count": MAX_DEFERS},
    )

    with pytest.raises(RuntimeError):
        await consumer.handle(message)


# ── Lock com dono ────────────────────────────────────────────────────────────
# `release` era um DELETE incondicional. Se o job passava do TTL, outro worker
# pegava o lock; quando o primeiro terminava, apagava o lock do segundo, e um
# terceiro podia entrar em paralelo — quebrando a ordem por telefone.


async def test_nao_libera_o_lock_que_ja_passou_a_outro_worker(
    broker, consumer, env, monkeypatch
):
    import src.services.message_processor as mp

    store = get_state_store()
    chave = lock_key(PHONE)
    outro: dict[str, str | None] = {}
    original = mp.MessageProcessor.process_job

    async def processamento_que_passa_do_ttl(self, job):
        # O TTL vence no meio do trabalho e outro worker adquire o lock.
        store.expire_lock_now(chave)
        outro["token"] = await store.acquire(chave, 60)
        await original(self, job)

    monkeypatch.setattr(mp.MessageProcessor, "process_job", processamento_que_passa_do_ttl)

    await publish_job(broker, make_job())
    await broker.drain()

    assert outro["token"] is not None
    # O lock do outro worker continua de pé: um terceiro não consegue entrar.
    assert await store.acquire(chave, 60) is None
    assert await store.release(chave, outro["token"]) is True


async def test_renova_o_lock_enquanto_o_job_roda(broker, consumer, env, monkeypatch):
    import src.services.message_processor as mp
    from src.config import settings

    # TTL de 3 s → renovação a cada 1 s. O job leva mais que um intervalo.
    monkeypatch.setattr(settings, "processing_lock_ttl_seconds", 3)
    store = get_state_store()
    renovacoes: list[str] = []
    extend_original = store.extend

    async def extend_espiao(key, token, ttl):
        renovacoes.append(key)
        return await extend_original(key, token, ttl)

    monkeypatch.setattr(store, "extend", extend_espiao)
    original = mp.MessageProcessor.process_job

    async def processamento_lento(self, job):
        await asyncio.sleep(1.3)
        await original(self, job)

    monkeypatch.setattr(mp.MessageProcessor, "process_job", processamento_lento)

    await publish_job(broker, make_job())
    await broker.drain()

    assert renovacoes == [lock_key(PHONE)]
    # Ao terminar, o lock é liberado de verdade — a renovação não o prende.
    token = await store.acquire(lock_key(PHONE), 60)
    assert token is not None


async def test_renovacao_para_quando_o_lock_foi_perdido(consumer, monkeypatch):
    from src.services.metrics import metrics

    store = get_state_store()
    chave = lock_key(PHONE)
    token = await store.acquire(chave, 60)
    store.expire_lock_now(chave)
    assert await store.acquire(chave, 60) is not None  # outro worker entrou

    perdas: list[str] = []
    monkeypatch.setattr(metrics, "incr", lambda nome, *a, **k: perdas.append(nome))
    monkeypatch.setattr(asyncio, "sleep", _sleep_instantaneo)

    # Não fica renovando para sempre um lock que já não é dele.
    await asyncio.wait_for(consumer._manter_lock(chave, token, 3), timeout=2)

    assert perdas == ["processing_lock_lost"]


_sleep_real = asyncio.sleep


async def _sleep_instantaneo(_segundos: float) -> None:
    await _sleep_real(0)


# ── Assinatura e validação (casos 19 e 20) ───────────────────────────────────
async def test_sem_assinatura_nao_chama_llm_nem_cria_lancamento(broker, consumer, env):
    env.gate.allowed = False
    env.gate.message = "Regularize sua assinatura para continuar."

    await publish_job(broker, make_job())
    await broker.drain()

    assert env.llm_calls == 0
    assert "create" not in env.calls
    assert env.sent == ["Regularize sua assinatura para continuar."]
    assert len(broker.acked) == 1


async def test_recusa_da_api_e_repassada_ao_usuario(broker, consumer, env, monkeypatch):
    """Conta/categoria de outro usuário: a API recusa e o usuário é avisado."""
    import src.services.message_processor as mp

    async def recusa(intent, user_id, raw, **kwargs):
        env.calls.append("create")
        return {
            "ok": False,
            "message": "Não consegui registrar o lançamento. Verifique os dados e tente de novo.",
        }

    monkeypatch.setattr(
        mp, "transaction_creator", type("Fake", (), {"create_from_intent": staticmethod(recusa)})()
    )

    await publish_job(broker, make_job())
    await broker.drain()

    assert env.sent == [
        "Não consegui registrar o lançamento. Verifique os dados e tente de novo."
    ]
    assert len(broker.acked) == 1


# ── Contrato ─────────────────────────────────────────────────────────────────
async def test_job_invalido_vai_para_a_dlq(broker, consumer, env):
    await broker.publish_body(ROUTE_PROCESSING, b'{"schemaVersion": 1, "phone": ""}')
    await broker.drain()

    assert len(broker.dlq) == 1
    assert broker.dlq[0].permanent is True
    assert env.calls == []


# ── Comprovante ──────────────────────────────────────────────────────────────
async def test_comprovante_usa_intent_pre_extraido_sem_chamar_llm(broker, consumer, env):
    intent = FinancialIntent(
        intent=IntentType.create_transaction,
        transaction_type=TransactionTypeEnum.expense,
        amount=99.9,
        description="Comprovante",
        confidence=0.9,
    )
    job = make_job(
        "comprovante (imagem)",
        pre_extracted_intent=intent.model_dump(mode="json"),
        force_confirm=True,
        confirm_question="Confirma o lançamento?",
    )

    await publish_job(broker, job)
    await broker.drain()

    assert env.llm_calls == 0
    assert "create" not in env.calls  # pediu confirmação, não criou
    assert env.sent == ["Confirma o lançamento?"]


def _broker_message(job: ProcessingJobV1):
    from src.messaging.base import BrokerMessage

    return BrokerMessage(
        body=job.model_dump_json(by_alias=True).encode(), routing_key=ROUTE_PROCESSING
    )


# ── Extração (auditoria) ─────────────────────────────────────────────────────
async def test_retry_nao_duplica_extracao_e_reusa_o_mesmo_registro(broker, consumer, env):
    """Sem isso, a segunda extração ficaria órfã: o lançamento é deduplicado
    antes e não chegaria a vinculá-la."""
    job = make_job()
    env.creator.fail_after_create = True

    await publish_job(broker, job)
    await broker._dispatch(broker.queues[ROUTE_PROCESSING].popleft(), consumer.handle)

    env.creator.fail_after_create = False
    await broker.drain()

    assert env.calls.count("log_extraction") == 2  # duas chamadas...
    assert len(env.extractions) == 1  # ...uma única extração
    assert env.extraction_duplicates == 1
    # As duas tentativas vincularam o lançamento à mesma extração.
    assert env.linked == ["ext-1", "ext-1"]


async def test_jobs_diferentes_geram_extracoes_diferentes(broker, consumer, env):
    await publish_job(broker, make_job(source_message_ids=["ai-1"]))
    await broker.drain()
    await publish_job(broker, make_job("recebi 100", source_message_ids=["ai-2"]))
    await broker.drain()

    assert len(env.extractions) == 2
    assert env.extraction_duplicates == 0


async def test_confirmacao_pendente_tambem_usa_a_chave_do_job(broker, consumer, env):
    """O ramo que só pergunta também precisa ser idempotente no retry."""
    job = make_job(
        "comprovante (imagem)",
        pre_extracted_intent=FinancialIntent(
            intent=IntentType.create_transaction,
            transaction_type=TransactionTypeEnum.expense,
            amount=99.9,
            confidence=0.9,
        ).model_dump(mode="json"),
        force_confirm=True,
        confirm_question="Confirma?",
    )

    await publish_job(broker, job)
    await broker.drain()
    # Reentrega antes do marcador de conclusão (ex.: crash logo após o ack).
    await get_state_store().forget(done_key(job.job_id))
    await publish_job(broker, job)
    await broker.drain()

    assert len(env.extractions) == 1
    assert env.extraction_duplicates == 1
