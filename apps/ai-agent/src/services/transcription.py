"""Transcrição de áudio (STT) via OpenAI.

Recebe os bytes de um áudio do WhatsApp e devolve o texto. Requer
``OPENAI_API_KEY``; sem ela, o serviço fica indisponível (``None``) e o chamador
responde com uma mensagem de fallback.
"""

from __future__ import annotations

import io
import logging
import mimetypes

from ..config import settings
from .metrics import metrics

logger = logging.getLogger(__name__)


class TranscriptionService:
    def __init__(self) -> None:
        self._client = None
        if settings.openai_api_key:
            try:
                from openai import AsyncOpenAI

                self._client = AsyncOpenAI(api_key=settings.openai_api_key)
            except Exception:  # noqa: BLE001
                logger.warning("Não foi possível inicializar o cliente de transcrição", exc_info=True)

    @property
    def available(self) -> bool:
        return self._client is not None

    async def transcribe(self, audio_bytes: bytes, mime: str | None = None) -> str | None:
        """Transcreve o áudio. Retorna o texto ou ``None`` em indisponível/falha."""
        if self._client is None:
            logger.info("Transcrição indisponível (OPENAI_API_KEY ausente)")
            return None

        # A API de áudio infere o formato pela extensão do nome do arquivo.
        ext = mimetypes.guess_extension(mime or "") or ".ogg"
        buffer = io.BytesIO(audio_bytes)
        buffer.name = f"audio{ext}"

        try:
            result = await self._client.audio.transcriptions.create(
                model=settings.openai_transcription_model,
                file=buffer,
            )
        except Exception:  # noqa: BLE001
            metrics.incr("transcription_fail")
            logger.warning("Falha ao transcrever áudio", exc_info=True)
            return None

        text = (getattr(result, "text", "") or "").strip()
        if not text:
            metrics.incr("transcription_fail")
            return None
        metrics.incr("transcription_success")
        return text


transcription_service = TranscriptionService()
