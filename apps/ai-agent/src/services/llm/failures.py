"""Registro das falhas de chamada ao provedor de IA (texto, comprovante, áudio).

Toda falha tem um caminho de contorno (regras, pedir para digitar), e foi isso
que escondeu uma ``OPENAI_API_KEY`` inválida em produção: o agente seguia
funcionando, só que pior, e o log dizia apenas "LLM falhou". Aqui a credencial
recusada vira **erro** com contador próprio (``llm_auth_failed``), que tem
alerta — ela não se resolve sozinha, ao contrário de um timeout.
"""

from __future__ import annotations

import logging

from ..metrics import metrics

#: Status HTTP de credencial recusada (chave inválida, revogada ou sem acesso).
_CREDENTIAL_STATUS = (401, 403)


def is_credential_error(exc: BaseException) -> bool:
    """A falha é a chave do provedor, e não instabilidade dele.

    Lê o ``status_code`` que os erros HTTP do SDK da OpenAI carregam, sem
    importar o SDK: o domínio não depende do provedor.
    """
    return getattr(exc, "status_code", None) in _CREDENTIAL_STATUS


def report_failure(logger: logging.Logger, what: str, exc: BaseException) -> None:
    """Loga a falha com o tipo do erro na própria linha.

    O tipo na mensagem (e não só no traceback) é o que aparece quando o
    visualizador de log corta a linha — como no console do Railway.
    """
    kind = type(exc).__name__
    if is_credential_error(exc):
        metrics.incr("llm_auth_failed")
        logger.error(
            "%s: o provedor de IA recusou a credencial (%s). Confira OPENAI_API_KEY",
            what,
            kind,
            exc_info=exc,
        )
        return
    logger.warning("%s (%s)", what, kind, exc_info=exc)
