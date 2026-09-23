"""Resolução de mídia (áudio/imagem) em conteúdo aproveitável.

Extraído de ``media_processor`` para que o **consumer de entrada** possa baixar
e interpretar a mídia fora do ciclo HTTP do webhook. O resolvedor não conhece
broker, fila nem resposta ao usuário: recebe a referência da mídia e devolve
transcrição (áudio) ou um ``FinancialIntent`` (comprovante).

Quem chama é responsável por verificar contato e assinatura **antes**, já que
transcrição e visão são operações pagas.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from ..schemas.financial_intent import FinancialIntent, TransactionTypeEnum
from .intent_classifier import intent_classifier
from .transcription import transcription_service
from .whatsapp_media import whatsapp_media

logger = logging.getLogger(__name__)

UNSUPPORTED_MEDIA_MESSAGE = (
    "Por enquanto só consigo processar texto, áudio e foto de comprovante 🙂. "
    "Esse tipo de mensagem ainda não é suportado."
)


def text_too_long_message(max_chars: int) -> str:
    """Resposta ao texto que passou do limite, com o limite explicito."""
    return (
        f"Sua mensagem passou do limite de {max_chars} caracteres e não foi processada. "
        "Pode resumir ou enviar o lançamento em uma mensagem mais curta?"
    )


DOWNLOAD_FALLBACK = "Não consegui baixar sua mídia. Pode tentar enviar novamente?"
AUDIO_FALLBACK = (
    "Não consegui entender o áudio. Pode repetir mais devagar ou digitar o lançamento?"
)
IMAGE_FALLBACK = (
    "Não consegui ler o comprovante. Pode enviar uma foto mais nítida ou digitar os dados?"
)

_TYPE_LABEL = {
    TransactionTypeEnum.income: "receita",
    TransactionTypeEnum.expense: "despesa",
}


def build_confirmation_question(intent: FinancialIntent) -> str:
    """Resumo do comprovante lido, para o usuário confirmar."""
    parts: list[str] = []
    if intent.transaction_type is not None:
        parts.append(_TYPE_LABEL.get(intent.transaction_type, ""))
    if intent.amount is not None:
        parts.append(f"R$ {intent.amount:.2f}")
    if intent.category_name:
        parts.append(f"categoria {intent.category_name}")
    if intent.transaction_date:
        parts.append(f"em {intent.transaction_date}")
    resumo = ", ".join(p for p in parts if p)
    desc = f" ({intent.description})" if intent.description else ""
    return f"Li o comprovante: {resumo}{desc}. Confirma o lançamento? (sim/não)"


@dataclass
class MediaResolution:
    """Resultado da resolução de uma mídia.

    - ``fallback_message`` preenchido → responder isso ao usuário e encerrar;
    - ``transcript`` preenchido → áudio virou texto (entra no agrupamento);
    - ``intent`` preenchido → comprovante lido (vira job próprio, com confirmação).
    """

    fallback_message: str | None = None
    transcript: str | None = None
    intent: FinancialIntent | None = None
    confirm_question: str | None = None
    log_content: str = ""


class MediaResolver:
    async def resolve(
        self,
        *,
        kind: str,
        media_id: str | None,
        media_mime: str | None,
        caption: str | None,
        context: dict,
    ) -> MediaResolution:
        if not media_id:
            return MediaResolution(fallback_message=UNSUPPORTED_MEDIA_MESSAGE)

        media = await whatsapp_media.fetch(media_id)
        if media is None:
            return MediaResolution(fallback_message=DOWNLOAD_FALLBACK)
        content, mime = media

        if kind == "audio":
            return await self._resolve_audio(content, media_mime or mime)
        if kind == "image":
            return await self._resolve_image(content, media_mime or mime, caption, context)
        return MediaResolution(fallback_message=UNSUPPORTED_MEDIA_MESSAGE)

    async def _resolve_audio(self, content: bytes, mime: str) -> MediaResolution:
        transcript = await transcription_service.transcribe(content, mime)
        if not transcript:
            return MediaResolution(fallback_message=AUDIO_FALLBACK)
        return MediaResolution(transcript=transcript, log_content=transcript)

    async def _resolve_image(
        self, content: bytes, mime: str, caption: str | None, context: dict
    ) -> MediaResolution:
        intent = await intent_classifier.classify_image(content, mime, caption, context)
        # Sem visão disponível, falha de leitura, ou sem valor → fallback.
        if intent is None or intent.amount is None:
            return MediaResolution(fallback_message=IMAGE_FALLBACK)
        return MediaResolution(
            intent=intent,
            confirm_question=build_confirmation_question(intent),
            log_content=caption or "[comprovante]",
        )


media_resolver = MediaResolver()
