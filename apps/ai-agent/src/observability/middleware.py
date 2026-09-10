"""Middleware de correlacao da API do agente.

Abre o contexto de log com o ``x-correlation-id`` recebido — ou um novo — e ecoa
o id na resposta. Sem isso, um fluxo que comeca na API principal (o cadastro que
dispara as boas-vindas, por exemplo) aparecia no Loki com **dois** ids: o da API
e outro, gerado aqui. Dois ids para um fluxo e o mesmo que nenhum.

O webhook da Meta nao envia o header, e ai gerar e o certo. O que muda e que
agora, quando alguem envia, o id e respeitado.
"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from .logging import CORRELATION_HEADER, log_context, sanitize_correlation_id


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        correlation_id = sanitize_correlation_id(request.headers.get(CORRELATION_HEADER))

        with log_context(correlation_id=correlation_id):
            response = await call_next(request)

        response.headers[CORRELATION_HEADER] = correlation_id
        return response
