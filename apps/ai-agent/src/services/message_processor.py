"""Processamento de uma mensagem (consolidada) já bufferizada.

Extraído de ``webhook._process_message`` (Etapa 2 do plano). Roda fora do
request HTTP, a partir do flush do :class:`MessageBuffer`. Mantém a ordem:
resolver contato → confirmação pendente → classificar (com contexto/histórico)
→ criar lançamento ou perguntar → enviar resposta via ``messenger`` →
registrar outbound/extração.
"""

import logging
from datetime import date

from ..config import settings
from ..schemas.financial_intent import FinancialIntent, IntentType
from .audit_service import audit_service
from .confirmation_rules import needs_confirmation
from .contact_service import contact_service
from .conversation_manager import conversation_manager
from .intent_classifier import intent_classifier
from .messenger import messenger
from .metrics import metrics
from .subscription_gate import subscription_gate
from .transaction_creator import transaction_creator

logger = logging.getLogger(__name__)

NOT_LINKED_MESSAGE = (
    "Seu número não está vinculado a uma conta. Acesse o app para vincular."
)
HELP_MESSAGE = (
    "Posso registrar seus lançamentos! Ex.: 'gastei 100 no mercado' ou "
    "'recebi 5000 de salário'. Você também pode pedir um resumo."
)
AFFIRMATIVE = ("sim", "isso", "confirmo", "ok", "pode", "correto", "certo", "exato")
NEGATIVE = ("não", "nao", "cancela", "cancelar", "errado", "deixa")


class MessageProcessor:
    async def process_buffered_message(
        self,
        phone: str,
        combined_message: str,
        source_message_ids: list[str] | None = None,
    ) -> str:
        """Processa a mensagem consolidada e devolve a resposta enviada.

        ``source_message_ids`` são os ids das ``AiMessage`` inbound já
        persistidas pelo buffer (a última é usada como origem da extração).
        """
        message = combined_message.strip()
        last_inbound_id = source_message_ids[-1] if source_message_ids else None

        metrics.incr("messages_processed")

        contact = await contact_service.find_by_phone(phone)
        if contact is None:
            metrics.incr("not_linked")
            logger.info("Contato não vinculado: %s", phone)
            return await self._respond(phone, NOT_LINKED_MESSAGE)

        user_id = contact["userId"]

        # Bloqueia antes de qualquer operação paga (LLM/criação) se sem assinatura.
        allowed, block_message = await subscription_gate.evaluate(user_id)
        if not allowed:
            metrics.incr("subscription_blocked")
            logger.info("Acesso bloqueado por assinatura: %s", phone)
            return await self._respond(phone, block_message or NOT_LINKED_MESSAGE)

        state = conversation_manager.get(phone)

        if state.awaiting_confirmation and state.pending_intent is not None:
            intent, confirmed = self._merge_confirmation_reply(state.pending_intent, message)
            if confirmed is False:  # usuário cancelou
                conversation_manager.clear(phone)
                return await self._respond(phone, "Ok, cancelei. Nada foi registrado.")
        else:
            context = await self._build_context(user_id, contact, phone)
            intent = await intent_classifier.classify(message, context)

        return await self.handle_intent(phone, user_id, intent, message, last_inbound_id)

    async def handle_intent(
        self,
        phone: str,
        user_id: str,
        intent: FinancialIntent,
        raw_message: str,
        last_inbound_id: str | None = None,
        *,
        response_prefix: str = "",
        force_confirm: bool = False,
        confirm_question: str | None = None,
    ) -> str:
        """Trata um ``FinancialIntent`` já extraído (texto, áudio ou imagem).

        ``response_prefix`` é prefixado na resposta final (ex.: eco da transcrição
        de áudio). ``force_confirm`` força o ramo de confirmação independentemente
        das regras (usado para comprovantes/imagem).
        """
        # Intenções não-transacionais.
        if intent.intent == IntentType.help:
            return await self._respond(phone, response_prefix + HELP_MESSAGE)
        if intent.intent == IntentType.query_summary:
            return await self._respond(
                phone,
                response_prefix
                + "Consulta de resumo via WhatsApp ainda não está disponível. Veja no app.",
            )
        if intent.intent in (IntentType.cancel_last, IntentType.correct_last):
            return await self._respond(
                phone,
                response_prefix
                + "Para corrigir ou cancelar um lançamento, use o app por enquanto.",
            )

        if force_confirm:
            must_confirm = True
            question = confirm_question or "Confirma o lançamento?"
        else:
            must_confirm, question = needs_confirmation(intent, raw_message)

        if must_confirm:
            metrics.incr("confirmation_requested")
            conversation_manager.set_pending(phone, intent)
            await audit_service.log_extraction(
                user_id=user_id,
                raw_input=raw_message,
                extracted_payload=intent.model_dump(mode="json"),
                confidence=intent.confidence,
                status="pending",
                source_message_id=last_inbound_id,
            )
            return await self._respond(phone, response_prefix + question)

        # Pronto para criar: registra a extração e cria o lançamento.
        extraction_id = await audit_service.log_extraction(
            user_id=user_id,
            raw_input=raw_message,
            extracted_payload=intent.model_dump(mode="json"),
            confidence=intent.confidence,
            status="confirmed",
            source_message_id=last_inbound_id,
        )

        result = await transaction_creator.create_from_intent(
            intent, user_id, raw_message, ai_extracted_transaction_id=extraction_id
        )
        conversation_manager.clear(phone)

        metrics.incr("transactions_created" if result.get("ok") else "transaction_failed")

        return await self._respond(phone, response_prefix + result["message"])

    async def _respond(self, phone: str, text: str) -> str:
        """Envia a resposta ao usuário e registra como outbound."""
        await messenger.send(phone, text)
        await audit_service.log_message(phone, "outbound", text)
        return text

    def _merge_confirmation_reply(
        self, pending: FinancialIntent, reply: str
    ) -> tuple[FinancialIntent, bool | None]:
        """Funde a resposta do usuário ao intent pendente.

        Retorna ``(intent, confirmed)`` onde ``confirmed`` é ``False`` se o
        usuário negou, ``True`` se confirmou, ``None`` caso indefinido.
        """
        text = reply.lower().strip()

        if any(word in text for word in NEGATIVE):
            return pending, False

        # Extrai campos da resposta por regras e preenche o que faltava.
        extracted = intent_classifier.classify_with_rules(reply)
        if extracted.amount is not None:
            pending.amount = extracted.amount
        if extracted.transaction_type is not None:
            pending.transaction_type = extracted.transaction_type
        if extracted.category_name is not None:
            pending.category_name = extracted.category_name
        if extracted.transaction_date is not None and "hoje" not in reply.lower():
            pending.transaction_date = extracted.transaction_date

        confirmed: bool | None = None
        if any(word in text for word in AFFIRMATIVE):
            confirmed = True

        # Resposta complementar (ex.: nome de categoria) eleva a confiança.
        pending.confidence = max(pending.confidence, settings.confidence_threshold)
        pending.needs_confirmation = False
        return pending, confirmed

    async def _build_context(self, user_id: str, contact: dict, phone: str) -> dict:
        """Contexto para o LLM: categorias, contas, data e histórico recente."""
        from ..services.api_client import api_client
        from ..services.conversation_history_service import conversation_history_service

        categories: list[str] = []
        accounts: list[str] = []
        try:
            cat_resp = await api_client.get(f"/internal/users/{user_id}/categories")
            if cat_resp.status_code == 200:
                categories = [c["name"] for c in cat_resp.json()]
            acc_resp = await api_client.get(f"/internal/users/{user_id}/accounts")
            if acc_resp.status_code == 200:
                accounts = [a["name"] for a in acc_resp.json()]
        except Exception:  # noqa: BLE001
            logger.warning(
                "Não foi possível carregar contexto do usuário %s", user_id, exc_info=True
            )

        recent_messages = await conversation_history_service.get_recent_messages(
            phone, settings.conversation_context_message_limit
        )

        return {
            "today": date.today().isoformat(),
            "categories": categories,
            "accounts": accounts,
            "profile_type": contact.get("profileType"),
            "recent_messages": recent_messages,
            "current_message": None,  # preenchido pelo classificador com a mensagem atual
        }


message_processor = MessageProcessor()
