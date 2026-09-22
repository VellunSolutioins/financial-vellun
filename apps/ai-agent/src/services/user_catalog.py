"""Categorias e contas do usuário, memorizadas **por job**.

Uma mensagem que vira lançamento buscava as duas listas duas vezes: uma para
montar o contexto do LLM (`message_processor._build_context`) e outra para
resolver conta e categoria na criação (`transaction_creator`). Quatro chamadas
HTTP à API principal por mensagem, metade delas repetindo a resposta que já
estava na memória do mesmo processo, no mesmo segundo.

**Por job, e não em Redis.** O plano de performance (P6) é explícito sobre a
ordem: primeiro a memo, que elimina a chamada duplicada sem nenhum risco de
consistência, e só depois — se a medição justificar — um cache compartilhado.
A diferença importa: a memo vive o tempo de um job (segundos, um processo), e
uma categoria criada no app aparece na mensagem seguinte. Um cache em Redis com
TTL faria o usuário criar uma categoria e o bot insistir que ela não existe.

**Nunca identidade, assinatura ou sessão** (contratos C2 e C3): nada disso passa
por aqui, nem deve passar. O que este módulo guarda é catálogo — dado que o
próprio usuário acabou de ver na tela.

Fora de um job ativo a memo simplesmente não existe, e cada chamada vai à API.
Quem abre o escopo é o consumer, com :meth:`UserCatalog.memo`.
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from contextvars import ContextVar

from .api_client import api_client
from .metrics import metrics

logger = logging.getLogger(__name__)

#: ``{(tipo, user_id): lista}`` enquanto um job está em processamento.
_memo: ContextVar[dict[tuple[str, str], list[dict]] | None] = ContextVar(
    "user_catalog_memo", default=None
)


class UserCatalog:
    @contextmanager
    def memo(self):
        """Abre o escopo de memorização de um job.

        Cada entrada e saída cria um dicionário novo: dois jobs nunca
        compartilham catálogo, nem mesmo do mesmo usuário. É o que mantém a
        janela de desatualização do tamanho de um job.
        """
        token = _memo.set({})
        try:
            yield
        finally:
            _memo.reset(token)

    async def categories(self, user_id: str) -> list[dict]:
        return await self._fetch("categories", user_id, f"/internal/users/{user_id}/categories")

    async def accounts(self, user_id: str) -> list[dict]:
        return await self._fetch("accounts", user_id, f"/internal/users/{user_id}/accounts")

    async def _fetch(self, tipo: str, user_id: str, path: str) -> list[dict]:
        cache = _memo.get()
        chave = (tipo, user_id)
        if cache is not None and chave in cache:
            metrics.incr(f"catalog_{tipo}_memo_hit")
            return cache[chave]

        try:
            response = await api_client.get(path)
            dados = response.json() if response.status_code == 200 else []
        except Exception:  # noqa: BLE001 — sem catálogo o fluxo degrada, não quebra
            logger.warning("Não foi possível carregar %s do usuário", tipo, exc_info=True)
            dados = []

        if not isinstance(dados, list):
            dados = []

        # A lista vazia **também** é memorizada: com a API fora, repetir a
        # chamada dentro do mesmo job só adiciona timeout a um job que já vai
        # responder com o que tem.
        if cache is not None:
            cache[chave] = dados
        return dados


user_catalog = UserCatalog()
