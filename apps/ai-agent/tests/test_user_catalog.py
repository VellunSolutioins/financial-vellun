"""Memo por job de categorias e contas (P6 do plano de performance).

O que estes testes seguram é a **fronteira** da memo, não o ganho em si: um
cache que dura demais faria o usuário criar uma categoria no app e o bot
insistir que ela não existe. A memo vale o tempo de um job e acaba ali.
"""

from __future__ import annotations

import pytest

from src.services.user_catalog import UserCatalog


class FakeApi:
    """Conta as chamadas por caminho."""

    def __init__(self, status: int = 200) -> None:
        self.chamadas: list[str] = []
        self.status = status
        self.categorias = [{"id": "c1", "name": "Mercado"}]

    async def get(self, path: str, **kwargs):
        self.chamadas.append(path)

        class Resposta:
            def __init__(self, status, dados):
                self.status_code = status
                self._dados = dados

            def json(self):
                return self._dados

        dados = self.categorias if "categories" in path else [{"id": "a1", "name": "Conta"}]
        return Resposta(self.status, dados)


@pytest.fixture
def api(monkeypatch):
    fake = FakeApi()
    import src.services.user_catalog as modulo

    monkeypatch.setattr(modulo, "api_client", fake)
    return fake


async def test_dentro_do_job_busca_uma_vez_so(api):
    catalogo = UserCatalog()

    with catalogo.memo():
        await catalogo.categories("u1")
        await catalogo.categories("u1")
        await catalogo.accounts("u1")
        await catalogo.accounts("u1")

    # Era o dobro: uma rodada para o contexto do LLM, outra para resolver conta
    # e categoria na criação do lançamento.
    assert len(api.chamadas) == 2


async def test_usuarios_diferentes_nao_se_misturam(api):
    catalogo = UserCatalog()

    with catalogo.memo():
        await catalogo.categories("u1")
        await catalogo.categories("u2")

    assert api.chamadas == [
        "/internal/users/u1/categories",
        "/internal/users/u2/categories",
    ]


async def test_jobs_diferentes_nao_compartilham_catalogo(api):
    """A janela de desatualização é um job, não um processo.

    Se a memo sobrevivesse entre jobs, uma categoria criada no app entre duas
    mensagens só apareceria quando o cache expirasse — e o bot responderia que
    ela não existe.
    """
    catalogo = UserCatalog()

    with catalogo.memo():
        await catalogo.categories("u1")
    api.categorias = [{"id": "c1", "name": "Mercado"}, {"id": "c2", "name": "Pet"}]
    with catalogo.memo():
        resultado = await catalogo.categories("u1")

    assert len(api.chamadas) == 2
    assert [c["name"] for c in resultado] == ["Mercado", "Pet"]


async def test_fora_de_job_nao_memoriza(api):
    catalogo = UserCatalog()

    await catalogo.categories("u1")
    await catalogo.categories("u1")

    assert len(api.chamadas) == 2


async def test_api_fora_devolve_lista_vazia_sem_levantar(api, monkeypatch):
    catalogo = UserCatalog()

    async def explode(path, **kwargs):
        raise RuntimeError("API fora")

    monkeypatch.setattr(api, "get", explode)

    with catalogo.memo():
        # Vazio, e sem repetir a chamada: dentro do mesmo job, insistir só
        # acrescenta timeout a um job que já vai responder com o que tem.
        assert await catalogo.categories("u1") == []
        assert await catalogo.categories("u1") == []
