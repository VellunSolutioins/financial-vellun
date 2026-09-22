"""Cliente HTTP da API principal, com conexao reaproveitada.

O ``AsyncClient`` e criado sob demanda e recriado se tiver sido fechado — assim
o shutdown do pipeline pode fechar as conexoes sem inviabilizar um novo ciclo
(reinicio do lifespan, testes em sequencia).
"""

from __future__ import annotations

import httpx

from ..config import settings
from ..observability.logging import correlation_headers


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
        return await self._ensure().get(path, **kwargs)

    async def post(self, path: str, **kwargs) -> httpx.Response:
        kwargs["headers"] = self._headers(kwargs.get("headers"))
        return await self._ensure().post(path, **kwargs)

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None


api_client = ApiClient()
