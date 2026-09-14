"""Agrupamento por telefone: ordem, debounce, teto de idade e consolidação.

Cobre o caso obrigatório 12 (mensagens fragmentadas agrupadas na ordem correta)
e as garantias do flusher: publicação confirmada antes de limpar o buffer, e
``jobId`` determinístico para que uma republicação não vire um segundo job.
"""

from __future__ import annotations

import time

import pytest

from src.config import settings
from src.grouping import GroupEntry, GroupFlusherWorker, build_job
from src.grouping.memory_store import InMemoryGroupStore
from src.messaging.base import ROUTE_PROCESSING, PublishError
from src.messaging.contracts import ProcessingJobV1
from src.messaging.inmemory import InMemoryPublisher

PHONE = "+5541999999999"


def entry(text: str, index: int) -> GroupEntry:
    return GroupEntry(
        text=text,
        ai_message_id=f"ai-{index}",
        provider_message_id=f"wamid.{index}",
        correlation_id="corr-1",
    )


async def test_fragmentos_sao_consolidados_na_ordem_de_recebimento(group_store):
    for index, text in enumerate(["gastei", "47,50", "no mercado"], start=1):
        await group_store.append(PHONE, entry(text, index))

    job = build_job(PHONE, await group_store.peek(PHONE))

    assert job.combined_message == "gastei 47,50 no mercado"
    assert job.source_message_ids == ["ai-1", "ai-2", "ai-3"]
    assert job.provider_message_ids == ["wamid.1", "wamid.2", "wamid.3"]
    assert job.correlation_id == "corr-1"


async def test_job_id_e_deterministico_para_o_mesmo_conjunto(group_store):
    entries = [entry("a", 1), entry("b", 2)]
    primeiro = build_job(PHONE, entries)
    # Mesma origem em outra ordem de leitura continua gerando o mesmo job.
    segundo = build_job(PHONE, list(reversed(entries)))

    assert primeiro.job_id == segundo.job_id
    # Telefones diferentes nunca colidem.
    assert build_job("+5511888887777", entries).job_id != primeiro.job_id


async def test_telefones_diferentes_sao_isolados(group_store):
    await group_store.append(PHONE, entry("gastei 10", 1))
    await group_store.append("+5511888887777", entry("recebi 20", 2))

    assert len(await group_store.peek(PHONE)) == 1
    assert len(await group_store.peek("+5511888887777")) == 1


async def test_append_e_idempotente_por_provider_message_id(group_store):
    """O append pode ser chamado de novo no retry sem duplicar no grupo."""
    primeiro = await group_store.append(PHONE, entry("gastei 10", 1))
    repetido = await group_store.append(PHONE, entry("gastei 10", 1))

    assert (primeiro.length, primeiro.added) == (1, True)
    assert (repetido.length, repetido.added) == (1, False)
    assert len(await group_store.peek(PHONE)) == 1

    # Sem providerMessageId não há como deduplicar; entra como mensagem nova.
    sem_id = await group_store.append(PHONE, GroupEntry(text="e mais 5"))
    assert (sem_id.length, sem_id.added) == (2, True)


async def test_limite_de_mensagens_vence_o_debounce_na_hora(group_store, monkeypatch):
    monkeypatch.setattr(settings, "message_buffer_max_messages", 3)

    await group_store.append(PHONE, entry("a", 1))
    await group_store.append(PHONE, entry("b", 2))
    assert await group_store.due_phones() == []

    await group_store.append(PHONE, entry("c", 3))
    assert await group_store.due_phones() == [PHONE]


async def test_teto_de_idade_nao_e_estendido_por_novas_mensagens(group_store, monkeypatch):
    """Regressão: o vencimento é contado da **primeira** mensagem do grupo."""
    monkeypatch.setattr(settings, "message_buffer_debounce_seconds", 5)
    monkeypatch.setattr(settings, "message_buffer_max_age_seconds", 2)
    monkeypatch.setattr(settings, "message_buffer_max_messages", 10)

    await group_store.append(PHONE, entry("a", 1))
    primeiro_vencimento = group_store._due[PHONE]

    time.sleep(0.05)
    await group_store.append(PHONE, entry("b", 2))

    # O teto continua o mesmo: um fluxo contínuo não adia o flush para sempre.
    assert group_store._due[PHONE] == pytest.approx(primeiro_vencimento, abs=1e-6)


# ── Flusher ──────────────────────────────────────────────────────────────────
async def test_flusher_publica_e_so_entao_limpa_o_buffer(broker, group_store):
    worker = GroupFlusherWorker(group_store, InMemoryPublisher(broker))
    await group_store.append(PHONE, entry("gastei 10", 1))
    group_store.force_due(PHONE)

    assert await worker.tick() == 1

    jobs = [ProcessingJobV1.model_validate_json(m.body) for m in broker.published[ROUTE_PROCESSING]]
    assert len(jobs) == 1
    assert jobs[0].combined_message == "gastei 10"
    # Buffer e agendamento limpos apenas após o confirm.
    assert await group_store.peek(PHONE) == []
    assert await group_store.due_phones() == []


async def test_falha_na_publicacao_preserva_o_buffer(broker, group_store):
    worker = GroupFlusherWorker(group_store, InMemoryPublisher(broker))
    await group_store.append(PHONE, entry("gastei 10", 1))
    group_store.force_due(PHONE)
    broker.fail_publish = PublishError("broker fora")

    assert await worker.tick() == 0

    # Nada publicado e o grupo continua lá, para o próximo tick.
    assert broker.published[ROUTE_PROCESSING] == []
    assert len(await group_store.peek(PHONE)) == 1


async def test_republicacao_apos_crash_gera_o_mesmo_job_id(broker, group_store):
    """Crash entre o confirm e a limpeza republica o grupo — com o mesmo jobId."""
    publisher = InMemoryPublisher(broker)
    worker = GroupFlusherWorker(group_store, publisher)
    await group_store.append(PHONE, entry("gastei 10", 1))
    group_store.force_due(PHONE)

    primeiro = build_job(PHONE, await group_store.peek(PHONE))
    await worker.tick()

    # Simula o buffer que não chegou a ser limpo e volta a vencer.
    await group_store.append(PHONE, entry("gastei 10", 1))
    group_store.force_due(PHONE)
    await worker.tick()

    jobs = [ProcessingJobV1.model_validate_json(m.body) for m in broker.published[ROUTE_PROCESSING]]
    assert len(jobs) == 2
    assert jobs[0].job_id == jobs[1].job_id == primeiro.job_id


async def test_lock_impede_dois_workers_no_mesmo_telefone(broker, group_store):
    store_a = group_store
    worker = GroupFlusherWorker(store_a, InMemoryPublisher(broker))

    await store_a.append(PHONE, entry("gastei 10", 1))
    store_a.force_due(PHONE)
    # Outro worker já segurou o lock deste telefone.
    token = await store_a.acquire_lock(PHONE, settings.redis_lock_ttl_seconds)
    assert token is not None

    assert await worker.tick() == 0
    assert broker.published[ROUTE_PROCESSING] == []

    assert await store_a.release_lock(PHONE, token) is True
    assert await worker.tick() == 1


async def test_grupo_vazio_apenas_limpa_o_agendamento(broker):
    store = InMemoryGroupStore()
    worker = GroupFlusherWorker(store, InMemoryPublisher(broker))
    store._due[PHONE] = 0.0

    assert await worker.tick() == 0
    assert await store.due_phones() == []


# ── Fatiamento no limite de mensagens ────────────────────────────────────────
async def test_rajada_e_fatiada_no_limite_de_mensagens(broker, group_store, monkeypatch):
    """Regressão: o limite marcava o grupo como vencido mas não o cortava, e
    uma rajada virava um único job gigante."""
    monkeypatch.setattr(settings, "message_buffer_max_messages", 10)
    worker = GroupFlusherWorker(group_store, InMemoryPublisher(broker))

    for index in range(1, 26):
        await group_store.append(PHONE, entry(f"msg{index}", index))

    # Duas fatias cheias; as 5 restantes voltam a esperar o debounce.
    assert await worker.tick() == 2

    jobs = [ProcessingJobV1.model_validate_json(m.body) for m in broker.published[ROUTE_PROCESSING]]
    assert [len(job.source_message_ids) for job in jobs] == [10, 10]
    assert jobs[0].combined_message.split() == [f"msg{i}" for i in range(1, 11)]
    assert jobs[1].combined_message.split() == [f"msg{i}" for i in range(11, 21)]

    restantes = await group_store.peek(PHONE)
    assert [e.text for e in restantes] == [f"msg{i}" for i in range(21, 26)]


async def test_fatias_nao_perdem_nem_duplicam_mensagem(broker, group_store, monkeypatch):
    monkeypatch.setattr(settings, "message_buffer_max_messages", 4)
    monkeypatch.setattr(settings, "message_buffer_debounce_seconds", 0)
    worker = GroupFlusherWorker(group_store, InMemoryPublisher(broker))

    for index in range(1, 15):
        await group_store.append(PHONE, entry(f"msg{index}", index))

    # Ticks sucessivos até drenar (o resto abaixo do limite espera o debounce).
    for _ in range(5):
        group_store.force_due(PHONE)
        await worker.tick()

    jobs = [ProcessingJobV1.model_validate_json(m.body) for m in broker.published[ROUTE_PROCESSING]]
    entregues = [msg_id for job in jobs for msg_id in job.source_message_ids]

    assert entregues == [f"ai-{i}" for i in range(1, 15)]  # ordem, sem buraco
    assert len(entregues) == len(set(entregues))  # sem duplicata
    assert await group_store.peek(PHONE) == []


async def test_fatia_republicada_apos_crash_mantem_o_mesmo_job_id(broker, group_store, monkeypatch):
    """Crash entre o confirm e o descarte republica a **mesma** fatia."""
    monkeypatch.setattr(settings, "message_buffer_max_messages", 3)
    worker = GroupFlusherWorker(group_store, InMemoryPublisher(broker))

    for index in range(1, 7):
        await group_store.append(PHONE, entry(f"msg{index}", index))

    primeira = build_job(PHONE, await group_store.peek(PHONE, limit=3))
    await worker.tick()

    jobs = [ProcessingJobV1.model_validate_json(m.body) for m in broker.published[ROUTE_PROCESSING]]
    assert jobs[0].job_id == primeira.job_id
    # Fatias distintas nunca colidem.
    assert jobs[0].job_id != jobs[1].job_id


async def test_limite_de_fatias_por_tick_adia_o_resto(broker, group_store, monkeypatch):
    """Um backlog enorme não pode segurar o lock além do TTL."""
    from src.grouping.flusher import MAX_SLICES_PER_TICK

    monkeypatch.setattr(settings, "message_buffer_max_messages", 2)
    worker = GroupFlusherWorker(group_store, InMemoryPublisher(broker))

    for index in range(1, 2 * MAX_SLICES_PER_TICK + 11):
        await group_store.append(PHONE, entry(f"msg{index}", index))

    assert await worker.tick() == MAX_SLICES_PER_TICK
    assert await group_store.peek(PHONE) != []  # o resto ficou para o próximo tick


async def test_renova_o_lock_entre_fatias(broker, group_store, monkeypatch):
    """As fatias somadas podem passar do TTL: o lock é renovado antes de cada nova."""
    monkeypatch.setattr(settings, "message_buffer_max_messages", 10)
    worker = GroupFlusherWorker(group_store, InMemoryPublisher(broker))
    renovacoes: list[str] = []
    extend_original = group_store.extend_lock

    async def extend_espiao(phone, token, ttl):
        renovacoes.append(phone)
        return await extend_original(phone, token, ttl)

    monkeypatch.setattr(group_store, "extend_lock", extend_espiao)

    for index in range(1, 26):
        await group_store.append(PHONE, entry(f"msg{index}", index))

    assert await worker.tick() == 2
    # Uma renovação para passar da 1ª para a 2ª fatia; nenhuma depois da última.
    assert renovacoes == [PHONE]


async def test_para_de_fatiar_quando_perde_o_lock(broker, group_store, monkeypatch):
    """Sem o lock, outra instância pode estar consolidando o mesmo telefone: o
    resto fica para quem o detém agora, em vez de os dois publicarem juntos."""
    monkeypatch.setattr(settings, "message_buffer_max_messages", 10)
    worker = GroupFlusherWorker(group_store, InMemoryPublisher(broker))

    async def lock_perdido(phone, token, ttl):
        group_store.expire_lock_now(phone)
        await group_store.acquire_lock(phone, 60)  # outra instância entrou
        return False

    monkeypatch.setattr(group_store, "extend_lock", lock_perdido)

    for index in range(1, 26):
        await group_store.append(PHONE, entry(f"msg{index}", index))

    assert await worker.tick() == 1
    jobs = [ProcessingJobV1.model_validate_json(m.body) for m in broker.published[ROUTE_PROCESSING]]
    assert [len(job.source_message_ids) for job in jobs] == [10]
    # Nada se perde: o que não foi publicado continua no buffer.
    assert len(await group_store.peek(PHONE)) == 15
    # E o lock da outra instância segue de pé — não foi apagado no `finally`.
    assert await group_store.acquire_lock(PHONE, 60) is None


# ── peek/consume ─────────────────────────────────────────────────────────────
async def test_peek_com_limite_le_apenas_o_prefixo(group_store):
    for index in range(1, 6):
        await group_store.append(PHONE, entry(f"msg{index}", index))

    assert [e.text for e in await group_store.peek(PHONE, limit=2)] == ["msg1", "msg2"]
    assert len(await group_store.peek(PHONE)) == 5


async def test_consume_descarta_o_prefixo_e_reagenda(group_store):
    for index in range(1, 6):
        await group_store.append(PHONE, entry(f"msg{index}", index))

    restantes = await group_store.consume(PHONE, 2)

    assert restantes == 3
    assert [e.text for e in await group_store.peek(PHONE)] == ["msg3", "msg4", "msg5"]
    assert PHONE in group_store._due  # continua agendado


async def test_consume_de_tudo_limpa_o_agendamento(group_store):
    await group_store.append(PHONE, entry("msg1", 1))

    assert await group_store.consume(PHONE, 1) == 0
    assert await group_store.peek(PHONE) == []
    assert await group_store.due_phones() == []
