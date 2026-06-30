"""Processamento de mensagens de mídia (áudio/imagem) do WhatsApp.

Roda em background (fora do request do webhook). Baixa a mídia, converte para
intenção financeira e reaproveita ``message_processor.handle_intent`` para
confirmar/criar o lançamento e responder ao usuário.

- **Áudio:** transcreve → classifica como texto → cria, ecoando a transcrição.
- **Imagem (comprovante):** extrai por visão → **sempre pede confirmação**.
- **Falhas / OpenAI indisponível:** responde uma mensagem de fallback amigável.
"""

import logging

from ..schemas.financial_intent import FinancialIntent, TransactionTypeEnum
from .audit_service import audit_service
from .contact_service import contact_service
from .intent_classifier import intent_classifier
from .message_processor import NOT_LINKED_MESSAGE, message_processor
from .metrics import metrics
from .subscription_gate import subscription_gate
from .transcription import transcription_service
from .whatsapp_inbound import InboundMessage
from .whatsapp_media import whatsapp_media

logger = logging.getLogger(__name__)

UNSUPPORTED_MEDIA_MESSAGE = (
    "Por enquanto só consigo processar texto, áudio e foto de comprovante 🙂. "
    "Esse tipo de mensagem ainda não é suportado."
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
    TransactionTypeEnum.transfer: "transferência",
}


class MediaProcessor:
    async def process(self, phone: str, item: InboundMessage) -> str:
        """Processa um item de mídia e devolve a resposta enviada."""
        contact = await contact_service.find_by_phone(phone)
        if contact is None:
            metrics.incr("not_linked")
            return await message_processor._respond(phone, NOT_LINKED_MESSAGE)

        user_id = contact["userId"]

        # Bloqueia antes de baixar mídia/transcrever/visão se sem assinatura.
        allowed, block_message = await subscription_gate.evaluate(user_id)
        if not allowed:
            metrics.incr("subscription_blocked")
            return await message_processor._respond(phone, block_message or NOT_LINKED_MESSAGE)

        if not item.media_id:
            return await message_processor._respond(phone, UNSUPPORTED_MEDIA_MESSAGE)

        media = await whatsapp_media.fetch(item.media_id)
        if media is None:
            return await message_processor._respond(phone, DOWNLOAD_FALLBACK)
        content, mime = media

        if item.kind == "audio":
            metrics.incr("media_audio")
            return await self._process_audio(phone, user_id, contact, item, content, mime)
        if item.kind == "image":
            metrics.incr("media_image")
            return await self._process_image(phone, user_id, contact, item, content, mime)

        return await message_processor._respond(phone, UNSUPPORTED_MEDIA_MESSAGE)

    async def respond_unsupported(self, phone: str) -> str:
        """Resposta para tipos não suportados (vídeo, documento, sticker, etc.)."""
        metrics.incr("media_unsupported")
        return await message_processor._respond(phone, UNSUPPORTED_MEDIA_MESSAGE)

    async def _process_audio(
        self,
        phone: str,
        user_id: str,
        contact: dict,
        item: InboundMessage,
        content: bytes,
        mime: str,
    ) -> str:
        transcript = await transcription_service.transcribe(content, item.media_mime or mime)
        if not transcript:
            return await message_processor._respond(phone, AUDIO_FALLBACK)

        last_inbound_id = await self._log_inbound(phone, transcript, item)
        if last_inbound_id is False:  # duplicata já processada
            return ""

        context = await message_processor._build_context(user_id, contact, phone)
        intent = await intent_classifier.classify(transcript, context)
        prefix = f'Entendi: "{transcript}".\n'
        return await message_processor.handle_intent(
            phone, user_id, intent, transcript, last_inbound_id, response_prefix=prefix
        )

    async def _process_image(
        self,
        phone: str,
        user_id: str,
        contact: dict,
        item: InboundMessage,
        content: bytes,
        mime: str,
    ) -> str:
        last_inbound_id = await self._log_inbound(
            phone, item.caption or "[comprovante]", item
        )
        if last_inbound_id is False:  # duplicata já processada
            return ""

        context = await message_processor._build_context(user_id, contact, phone)
        intent = await intent_classifier.classify_image(
            content, item.media_mime or mime, item.caption, context
        )

        # Sem visão disponível, falha de leitura, ou sem valor → fallback.
        if intent is None or intent.amount is None:
            return await message_processor._respond(phone, IMAGE_FALLBACK)

        question = self._build_confirmation_question(intent)
        return await message_processor.handle_intent(
            phone,
            user_id,
            intent,
            item.caption or "comprovante (imagem)",
            last_inbound_id,
            force_confirm=True,
            confirm_question=question,
        )

    async def _log_inbound(
        self, phone: str, content: str, item: InboundMessage
    ) -> str | None | bool:
        """Persiste a inbound (idempotência por ``message_id``).

        Retorna o id persistido, ``None`` se não houver, ou ``False`` quando é
        uma duplicata já processada (o chamador deve parar)."""
        metadata: dict = {}
        if item.message_id is not None:
            metadata["messageId"] = item.message_id
        if item.timestamp is not None:
            metadata["timestamp"] = item.timestamp

        result = await audit_service.log_message_detailed(
            phone, "inbound", content, metadata=metadata or None
        )
        if result and result.get("duplicate"):
            metrics.incr("inbound_duplicate")
            logger.info("Mídia duplicada ignorada (message_id=%s)", item.message_id)
            return False
        return result.get("id") if result else None

    def _build_confirmation_question(self, intent: FinancialIntent) -> str:
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


media_processor = MediaProcessor()
