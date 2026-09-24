"""Resolução de conta/cartão do lançamento criado pelo WhatsApp.

A API devolve contas comuns e cartões ativos na mesma lista, marcados com
``kind``. O que estes testes seguram: o nome citado casa com os dois, e sem
menção a compra nunca cai num cartão por acaso.
"""

from __future__ import annotations

import pytest

from src.services import transaction_creator as modulo
from src.services.transaction_creator import TransactionCreator, display_name

RECURSOS = [
    {"id": "card-acc", "name": "Nubank", "kind": "card"},
    {"id": "acc-1", "name": "Itaú", "kind": "account"},
    {"id": "acc-2", "name": "Carteira", "kind": "account"},
]


@pytest.fixture
def catalogo(monkeypatch):
    lista: list[dict] = list(RECURSOS)

    class FakeCatalog:
        async def accounts(self, user_id: str) -> list[dict]:
            return lista

    monkeypatch.setattr(modulo, "user_catalog", FakeCatalog())
    return lista


async def test_sem_mencao_usa_a_primeira_conta_comum_e_nao_o_cartao(catalogo):
    # O cartão é o mais antigo da lista, mas não vira padrão.
    assert await TransactionCreator()._resolve_account("u1", None) == "acc-1"


async def test_nome_do_cartao_resolve_para_a_conta_interna_dele(catalogo):
    assert await TransactionCreator()._resolve_account("u1", "nubank") == "card-acc"


async def test_nome_com_sufixo_do_prompt_tambem_casa(catalogo):
    nome = display_name(RECURSOS[0])
    assert nome == "Nubank (cartão de crédito)"
    assert await TransactionCreator()._resolve_account("u1", nome) == "card-acc"


async def test_casamento_exato_vence_o_parcial(catalogo):
    catalogo.insert(0, {"id": "card-2", "name": "Itaú Platinum", "kind": "card"})
    assert await TransactionCreator()._resolve_account("u1", "Itau") == "acc-1"


async def test_nome_desconhecido_cai_na_conta_comum(catalogo):
    assert await TransactionCreator()._resolve_account("u1", "Bradesco") == "acc-1"


async def test_so_cartoes_sem_mencao_nao_resolve(catalogo):
    catalogo[:] = [RECURSOS[0]]
    assert await TransactionCreator()._resolve_account("u1", None) is None
    assert await TransactionCreator()._resolve_account("u1", "Nubank") == "card-acc"


async def test_api_antiga_sem_kind_trata_tudo_como_conta(catalogo):
    catalogo[:] = [{"id": "a1", "name": "Conta"}]
    assert await TransactionCreator()._resolve_account("u1", None) == "a1"
    assert display_name(catalogo[0]) == "Conta"
