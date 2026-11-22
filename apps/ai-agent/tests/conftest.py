"""Configuração comum dos testes.

Força os backends **em memória** antes de qualquer import de ``src``, para que a
suíte rode sem Docker (sem RabbitMQ e sem Redis). Os testes marcados com
``@pytest.mark.integration`` continuam exigindo a infraestrutura real e ficam de
fora da execução padrão (ver ``pyproject.toml``).
"""

from __future__ import annotations

import os

os.environ.setdefault("INTERNAL_API_KEY", "test-internal-key")
os.environ["MESSAGE_PIPELINE"] = "broker"
os.environ["MESSAGE_BROKER"] = "inmemory"
os.environ["GROUP_STORE_BACKEND"] = "memory"
os.environ["CONVERSATION_STATE_BACKEND"] = "memory"
os.environ["RUN_CONSUMERS_IN_API"] = "false"
os.environ["ENVIRONMENT"] = "development"
# Os testes de webhook postam sem assinatura; em ambiente local isso só é
# aceito com a opção explícita (plano de segurança, S1.4).
os.environ["WEBHOOK_ALLOW_UNSIGNED"] = "true"
# Variável de ambiente vence o `.env`: sem esta linha, o `LOKI_PUSH_URL` do
# `.env` do desenvolvedor ligava o envio de log na suíte, que passava a mandar
# linhas de teste para o Alloy local (ou a falhar com URLError, sem ele no ar).
os.environ["LOKI_PUSH_URL"] = ""

import pytest  # noqa: E402

from src.config import settings  # noqa: E402
from src.grouping import InMemoryGroupStore, set_group_store  # noqa: E402
from src.messaging.factory import inmemory_broker, reset_inmemory_broker  # noqa: E402
from src.services.conversation_manager import conversation_manager  # noqa: E402
from src.services.conversation_store import InMemoryConversationStore  # noqa: E402
from src.services.distributed_state import InMemoryStateStore, set_state_store  # noqa: E402
from src.services.outbound import outbound_dispatcher  # noqa: E402


@pytest.fixture(autouse=True)
def no_feature_flags():
    """Flags desligadas, sem consultar a API principal.

    Sem isto, a ajuda chamava ``/internal/features`` de verdade — na máquina do
    desenvolvedor, a API local respondia e o texto da ajuda dependia dela.
    Testes que precisam de uma flag ligada trocam ``feature_flags.enabled``.

    Sem ``monkeypatch`` de propósito: num fixture autouse ele seria criado
    antes dos fixtures do teste e desfeito depois deles, invertendo a ordem
    de teardown de quem usa ``client`` + ``monkeypatch`` (o lifespan fecharia
    os dublês em vez dos clientes reais).
    """
    from src.services.feature_flags import feature_flags

    async def _none() -> dict[str, bool]:
        return {}

    feature_flags.enabled = _none  # type: ignore[method-assign]
    yield
    del feature_flags.enabled


@pytest.fixture(autouse=True)
def payments_off():
    """Baixa e fatura desligadas (``whatsapp_payments``), sem chamar a API.

    A oferta "É o pagamento dela?" consulta os itens em aberto antes de cada
    lançamento; sem isto, todo teste de criação tentava a API de verdade.
    Testes da Fase 2 trocam ``action_processor._open_items``. Sem
    ``monkeypatch``, pelo mesmo motivo de ``no_feature_flags``.
    """
    from src.services import action_processor as module

    original = module._open_items

    async def _off(user_id, kind):
        raise module.FeatureDisabled

    module._open_items = _off
    yield
    module._open_items = original


@pytest.fixture(autouse=True)
def edit_off():
    """Corrigir e excluir desligados (``whatsapp_edit``), sem chamar a API.

    Testes da Fase 3 trocam ``entry_editor._recent``. Sem ``monkeypatch``,
    pelo mesmo motivo de ``no_feature_flags``.
    """
    from src.services import entry_editor as module

    original = module._recent

    async def _off(user_id):
        raise module.FeatureDisabled

    module._recent = _off
    yield
    module._recent = original


@pytest.fixture(autouse=True)
def isolated_state():
    """Zera todo estado global compartilhado entre testes."""
    # O `.env` do desenvolvedor pode trazer outros valores; o teste manda.
    settings.message_pipeline = "broker"
    settings.message_broker = "inmemory"
    settings.group_store_backend = "memory"
    settings.conversation_state_backend = "memory"
    settings.run_consumers_in_api = False
    settings.outbound_delivery = "queue"

    # Sem publisher ligado, o despachante entrega na hora. É o que mantém os
    # testes que não sobem o pipeline olhando o envio direto.
    outbound_dispatcher.bind(None)

    reset_inmemory_broker()
    store = InMemoryGroupStore()
    set_group_store(store)
    set_state_store(InMemoryStateStore())
    conversation_manager.use_store(InMemoryConversationStore())

    yield

    reset_inmemory_broker()
    set_group_store(None)
    set_state_store(None)
    conversation_manager.use_store(None)
    outbound_dispatcher.bind(None)


@pytest.fixture
def broker():
    """Broker em memória compartilhado por publisher e consumers."""
    return inmemory_broker()


@pytest.fixture
def group_store() -> InMemoryGroupStore:
    from src.grouping import get_group_store

    return get_group_store()  # type: ignore[return-value]
