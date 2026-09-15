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


@pytest.fixture(autouse=True)
def isolated_state():
    """Zera todo estado global compartilhado entre testes."""
    # O `.env` do desenvolvedor pode trazer outros valores; o teste manda.
    settings.message_pipeline = "broker"
    settings.message_broker = "inmemory"
    settings.group_store_backend = "memory"
    settings.conversation_state_backend = "memory"
    settings.run_consumers_in_api = False

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


@pytest.fixture
def broker():
    """Broker em memória compartilhado por publisher e consumers."""
    return inmemory_broker()


@pytest.fixture
def group_store() -> InMemoryGroupStore:
    from src.grouping import get_group_store

    return get_group_store()  # type: ignore[return-value]
