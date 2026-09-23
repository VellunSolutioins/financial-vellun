"""Cliente HTTP da API principal, com conexao reaproveitada.

O ``AsyncClient`` e criado sob demanda e recriado se tiver sido fechado — assim
o shutdown do pipeline pode fechar as conexoes sem inviabilizar um novo ciclo
(reinicio do lifespan, testes em sequencia).

Toda chamada e cronometrada por **rota agregada**
(``vellun_agent_internal_api_<rota>_seconds``). Sem isso, "o pipeline esta
lento" nao distingue IA lenta de API principal lenta — e o numero de chamadas
por mensagem e justamente o que o capacity review precisa saber.
"""

from __future__ import annotations

import re
import time

import httpx

from ..config import settings
from ..observability.logging import correlation_headers
from .metrics import metrics

#: Rotas internas que o agente chama, em **allowlist**: ``(regex, nome)``.
#:
#: Allowlist, e não uma heurística que "limpa" identificadores do caminho, por
#: uma razão concreta: telefone e uuid aparecem no meio da rota, e uma
#: heurística que errasse colocaria o número de alguém dentro de um **nome de
#: métrica**. Label livre é ruim (uma série por valor); nome de métrica é pior,
#: porque não dá para filtrar depois — e neste caso seria PII exportada.
#:
#: Rota fora da lista cai em ``outra``, e é o sinal de que esta lista ficou
#: para trás — um endpoint novo aparece como ``outra`` no dashboard.
_ROTAS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"^/internal/users/[^/]+/accounts$"), "users_accounts"),
    (re.compile(r"^/internal/users/[^/]+/categories$"), "users_categories"),
    (
        re.compile(r"^/internal/users/[^/]+/subscription-access$"),
        "users_subscription_access",
    ),
    (
        re.compile(r"^/internal/whatsapp/contacts/[^/]+/messages$"),
        "whatsapp_contact_messages",
    ),
    (re.compile(r"^/internal/whatsapp/contacts/[^/]+$"), "whatsapp_contact"),
    (re.compile(r"^/internal/whatsapp/verify$"), "whatsapp_verify"),
    (re.compile(r"^/internal/transactions/from-ai$"), "transactions_from_ai"),
    (re.compile(r"^/internal/ai-events$"), "ai_events"),
    (re.compile(r"^/internal/ops/failed-messages$"), "ops_failed_messages"),
)


def route_slug(path: str) -> str:
    """Nome agregado da rota, sempre de um conjunto fechado."""
    caminho = path.split("?", 1)[0]
    if not caminho.startswith("/"):
        caminho = "/" + caminho
    for padrao, nome in _ROTAS:
        if padrao.match(caminho):
            return nome
    return "outra"


def _timing_name(slug: str) -> str:
    return f"internal_api_{slug}_ms"


# Declarados na importação: um histograma que só nasce na primeira chamada
# deixaria "nenhuma chamada a esta rota" indistinguível de "a rota sumiu".
for _, _nome in _ROTAS:
    metrics.declare_timing(_timing_name(_nome))
metrics.declare_timing(_timing_name("outra"))


class ApiClient:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    def _ensure(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=settings.main_api_url,
                headers={"x-internal-api-key": settings.outgoing_api_key},
                timeout=30.0,
            )
        return self._client

    def _headers(self, extra: dict | None) -> dict:
        """Junta a correlacao do contexto aos headers da chamada.

        Precisa ser por requisicao, nao no cliente: o ``AsyncClient`` e
        compartilhado por todo o processo, e um header fixo carregaria o
        ``correlationId`` de outra mensagem.
        """
        return {**correlation_headers(), **(extra or {})}

    async def get(self, path: str, **kwargs) -> httpx.Response:
        kwargs["headers"] = self._headers(kwargs.get("headers"))
        return await self._timed(self._ensure().get, path, **kwargs)

    async def post(self, path: str, **kwargs) -> httpx.Response:
        kwargs["headers"] = self._headers(kwargs.get("headers"))
        return await self._timed(self._ensure().post, path, **kwargs)

    async def _timed(self, metodo, path: str, **kwargs) -> httpx.Response:
        """Cronometra a chamada, inclusive quando ela levanta.

        Medir so o caminho feliz esconderia exatamente o caso que interessa: a
        API que aceita a conexao e nao responde dentro do timeout.
        """
        started = time.monotonic()
        try:
            return await metodo(path, **kwargs)
        finally:
            metrics.observe_ms(
                _timing_name(route_slug(path)), (time.monotonic() - started) * 1000
            )

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None


api_client = ApiClient()
