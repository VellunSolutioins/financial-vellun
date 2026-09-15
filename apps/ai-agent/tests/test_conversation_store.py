"""Estado de conversa: serialização versionada, TTL e sobrevivência a restart.

Cobre o caso obrigatório 15: a confirmação pendente sobrevive ao reinício do
consumer. O teste usa um store externo compartilhado (o papel que o Redis
cumpre em produção) e recria o ``ConversationManager``, que é o que acontece
quando o processo é reiniciado.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum
from src.services.conversation_manager import ConversationManager
from src.services.conversation_store import (
    STATE_SCHEMA_VERSION,
    ConversationState,
    InMemoryConversationStore,
)

PHONE = "+5541999999999"


def pending_intent() -> FinancialIntent:
    return FinancialIntent(
        intent=IntentType.create_transaction,
        transaction_type=TransactionTypeEnum.expense,
        amount=47.5,
        description="mercado",
        category_name="Mercado",
        transaction_date="2026-09-05",
        confidence=0.6,
        needs_confirmation=True,
    )


async def test_confirmacao_pendente_sobrevive_ao_reinicio_do_consumer():
    store = InMemoryConversationStore()  # faz o papel do Redis (externo ao processo)

    antes = ConversationManager(store)
    await antes.set_pending(PHONE, pending_intent())

    # Reinício: um manager novo, sem nenhum estado em memória.
    depois = ConversationManager(store)
    estado = await depois.get(PHONE)

    assert estado.awaiting_confirmation is True
    assert estado.pending_intent is not None
    assert estado.pending_intent.amount == 47.5
    assert estado.pending_intent.category_name == "Mercado"


async def test_estado_vazio_quando_nao_ha_nada():
    manager = ConversationManager(InMemoryConversationStore())

    estado = await manager.get(PHONE)

    assert estado.awaiting_confirmation is False
    assert estado.pending_intent is None


async def test_clear_remove_a_confirmacao_pendente():
    store = InMemoryConversationStore()
    manager = ConversationManager(store)
    await manager.set_pending(PHONE, pending_intent())

    await manager.clear(PHONE)

    assert (await manager.get(PHONE)).awaiting_confirmation is False


async def test_estado_expirado_e_descartado():
    store = InMemoryConversationStore()
    manager = ConversationManager(store)
    manager._ttl_seconds = 60

    velho = ConversationState(
        pending_intent=pending_intent(),
        awaiting_confirmation=True,
        last_message_at=datetime.now(timezone.utc) - timedelta(seconds=120),
    )
    await store.save(PHONE, velho)

    estado = await manager.get(PHONE)

    assert estado.awaiting_confirmation is False
    assert await store.get(PHONE) is None  # limpo do store também


# ── Serialização ─────────────────────────────────────────────────────────────
def test_serializacao_tem_versao_e_faz_roundtrip():
    original = ConversationState(pending_intent=pending_intent(), awaiting_confirmation=True)

    restaurado = ConversationState.from_json(original.to_json())

    assert f'"v": {STATE_SCHEMA_VERSION}' in original.to_json()
    assert restaurado is not None
    assert restaurado.awaiting_confirmation is True
    assert restaurado.pending_intent.amount == 47.5


def test_versao_desconhecida_e_descartada_com_seguranca():
    assert ConversationState.from_json('{"v": 99, "awaitingConfirmation": true}') is None


def test_estado_corrompido_e_descartado_com_seguranca():
    assert ConversationState.from_json("isto não é json") is None


def test_intent_incompativel_e_descartado():
    payload = (
        '{"v": 1, "pendingIntent": {"intent": "inexistente"}, '
        '"awaitingConfirmation": true, "lastMessageAt": "2026-09-05T12:00:00+00:00"}'
    )
    assert ConversationState.from_json(payload) is None
