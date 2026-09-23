"""Verificação de posse do número de WhatsApp (plano de segurança, S1.1).

O app mostra um código e o usuário o envia ao bot **a partir do número que quer
vincular**. O número de origem vem do webhook assinado pela Meta — é isso que
prova a posse. Aqui o agente só reconhece o código na mensagem e pergunta à API
principal se ele confere; a decisão e o vínculo ficam na API.

A resposta de sucesso é a boas-vindas: como o usuário acabou de escrever, a
janela de 24 h da Meta está aberta e o texto livre é entregue sem template.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass

from ..messaging.base import TransientError
from .api_client import api_client
from .metrics import metrics
from .welcome_service import build_welcome_message

logger = logging.getLogger(__name__)

#: "Código: 123456" em qualquer ponto do texto, tolerando edição ao redor.
_CODE_AFTER_LABEL = re.compile(r"codigo\D{0,10}(\d{6})(?!\d)")
#: Só o código, sozinho na mensagem.
_BARE_CODE = re.compile(r"\s*(\d{6})\s*")

INVALID_CODE_MESSAGE = (
    "Esse código não confere. Confira o código exibido no app e envie de novo."
)
EXPIRED_CODE_MESSAGE = (
    "Esse código expirou ou já foi usado. Gere um novo código no app e envie aqui."
)
NO_PENDING_CODE_MESSAGE = (
    "Não encontrei uma verificação em andamento para este número. "
    "Gere um novo código no app e envie aqui."
)
ALREADY_LINKED_MESSAGE = "Seu WhatsApp já está vinculado à sua conta. ✅"


@dataclass(frozen=True)
class VerificationCode:
    """Código encontrado na mensagem.

    ``labeled`` distingue "Código: 123456" (a mensagem pré-preenchida pelo app)
    do número sozinho. Só o primeiro é tratado como código vindo de um número
    já vinculado: sozinho, "150000" pode ser a resposta a "qual o valor?".
    """

    value: str
    labeled: bool


def extract_verification_code(text: str) -> VerificationCode | None:
    """Código de 6 dígitos da mensagem de verificação, se houver.

    Exige a palavra "código" antes do número, ou o número sozinho: um valor
    qualquer de seis dígitos numa frase ("paguei 150000 no carro") não é código.
    """
    normalized = unicodedata.normalize("NFKD", text or "")
    normalized = "".join(c for c in normalized if not unicodedata.combining(c)).lower()
    labeled = _CODE_AFTER_LABEL.search(normalized)
    if labeled:
        return VerificationCode(labeled.group(1), labeled=True)
    bare = _BARE_CODE.fullmatch(normalized)
    return VerificationCode(bare.group(1), labeled=False) if bare else None


@dataclass(frozen=True)
class VerificationOutcome:
    """Resultado de conferir o código na API.

    ``reply`` é ``None`` quando não há desafio para o número (``not_found``):
    quem chama decide a resposta conforme o número já esteja vinculado ou não.
    """

    status: str
    reply: str | None


class PhoneVerificationService:
    async def confirm(self, phone: str, code: str) -> VerificationOutcome:
        """Pergunta à API se o código confere para este número.

        Falha de transporte ou resposta inesperada levanta
        :class:`TransientError`, para o job ser retentado — nunca responde
        "código inválido" por causa de uma queda da API.
        """
        try:
            response = await api_client.post(
                "/internal/whatsapp/verify", json={"phone": phone, "code": code}
            )
        except Exception as exc:  # noqa: BLE001 — qualquer falha de transporte
            raise TransientError(
                f"API principal indisponível ao verificar código: {type(exc).__name__}"
            ) from exc

        if response.status_code != 200:
            raise TransientError(
                f"resposta inesperada ({response.status_code}) ao verificar código"
            )

        body = response.json()
        status = body.get("status")
        if status == "verified":
            metrics.incr("phone_verified")
            logger.info("Número verificado pelo código enviado ao bot")
            return VerificationOutcome(status, build_welcome_message(body.get("name")))
        if status == "invalid_code":
            metrics.incr("phone_verification_invalid")
            return VerificationOutcome(status, INVALID_CODE_MESSAGE)
        if status == "expired":
            metrics.incr("phone_verification_expired")
            return VerificationOutcome(status, EXPIRED_CODE_MESSAGE)
        return VerificationOutcome("not_found", None)


phone_verification_service = PhoneVerificationService()
