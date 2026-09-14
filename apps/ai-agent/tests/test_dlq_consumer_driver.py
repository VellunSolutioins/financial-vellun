"""Ciclo de vida do canal do consumer da DLQ.

O bug que estes testes fixam: o canal era atribuído à instância assim que abria.
Se ``get_queue`` ou ``consume`` falhasse logo depois, o ``bootstrap`` engolia a
exceção e descartava a instância sem chamar ``stop()`` — e o canal ficava aberto
pela vida inteira do processo, a cada tentativa de subir o catálogo.
"""

from __future__ import annotations

import pytest

from src.messaging.rabbitmq.dlq_consumer import DlqCatalogConsumer


class CanalFalso:
    def __init__(self, fila=None, erro_get_queue: Exception | None = None) -> None:
        self.is_closed = False
        self.fechamentos = 0
        self._fila = fila
        self._erro = erro_get_queue

    async def get_queue(self, name, ensure=False):
        if self._erro:
            raise self._erro
        return self._fila

    async def close(self) -> None:
        self.fechamentos += 1
        self.is_closed = True


class FilaFalsa:
    def __init__(self, erro_consume: Exception | None = None) -> None:
        self._erro = erro_consume
        self.cancelados: list[str] = []

    async def consume(self, callback):
        if self._erro:
            raise self._erro
        return "tag-1"

    async def cancel(self, tag) -> None:
        self.cancelados.append(tag)


class ConexaoFalsa:
    def __init__(self, canal: CanalFalso) -> None:
        self.canal = canal

    async def dedicated_consume_channel(self, prefetch: int):
        return self.canal


def consumer(canal: CanalFalso) -> DlqCatalogConsumer:
    return DlqCatalogConsumer(
        ConexaoFalsa(canal), queue_name="whatsapp.inbound.dlq", routing_key="inbound.dlq"
    )


async def _handler(_message) -> None:  # pragma: no cover - não é chamado
    return None


async def test_fecha_o_canal_quando_get_queue_falha():
    canal = CanalFalso(erro_get_queue=RuntimeError("fila indisponível"))
    alvo = consumer(canal)

    with pytest.raises(RuntimeError, match="fila indisponível"):
        await alvo.start(_handler)

    assert canal.fechamentos == 1
    # A instância não fica segurando um canal que ninguém vai fechar.
    assert alvo._channel is None
    assert not await alvo.healthy()


async def test_fecha_o_canal_quando_consume_falha():
    canal = CanalFalso(fila=FilaFalsa(erro_consume=RuntimeError("broker piscou")))
    alvo = consumer(canal)

    with pytest.raises(RuntimeError, match="broker piscou"):
        await alvo.start(_handler)

    assert canal.fechamentos == 1
    assert alvo._channel is None


async def test_falha_ao_fechar_nao_esconde_a_excecao_original():
    canal = CanalFalso(erro_get_queue=RuntimeError("fila indisponível"))

    async def close_que_falha() -> None:
        raise ConnectionError("conexão já caiu")

    canal.close = close_que_falha  # type: ignore[method-assign]

    # O erro que explica por que o catálogo não subiu é o de `get_queue`, não o
    # do fechamento.
    with pytest.raises(RuntimeError, match="fila indisponível"):
        await consumer(canal).start(_handler)


async def test_sucesso_mantem_o_canal_e_stop_fecha():
    fila = FilaFalsa()
    canal = CanalFalso(fila=fila)
    alvo = consumer(canal)

    await alvo.start(_handler)

    assert canal.fechamentos == 0
    assert await alvo.healthy()

    await alvo.stop()

    assert fila.cancelados == ["tag-1"]
    assert canal.fechamentos == 1
    assert not await alvo.healthy()
