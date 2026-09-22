"""Processamento de uma mensagem (consolidada) já bufferizada.

Extraído de ``webhook._process_message`` (Etapa 2 do plano). Roda fora do
request HTTP, a partir do flush do :class:`MessageBuffer`. Mantém a ordem:
resolver contato → confirmação pendente → classificar (com contexto/histórico)
→ criar lançamento ou perguntar → enviar resposta via ``messenger`` →
registrar outbound/extração.
"""

import logging
import unicodedata
from contextvars import ContextVar

from ..config import settings
from ..messaging.contracts import ProcessingJobV1
from ..schemas.financial_intent import FinancialIntent, IntentType
from .audit_service import audit_service
from .clock import today_local
from .confirmation_rules import needs_confirmation
from .contact_service import contact_service
from .conversation_manager import ConversationState, conversation_manager
from .intent_classifier import intent_classifier
from .messenger import messenger
from .metrics import metrics
from .phone_verification import (
    ALREADY_LINKED_MESSAGE,
    NO_PENDING_CODE_MESSAGE,
    extract_verification_code,
    phone_verification_service,
)
from .subscription_gate import subscription_gate
from .transaction_creator import transaction_creator
from .usage_limiter import DAILY_LIMIT_MESSAGE, usage_limiter

logger = logging.getLogger(__name__)

NOT_LINKED_MESSAGE = (
    "Seu número ainda não está vinculado a uma conta. No app, abra Minha Conta, "
    "toque em \"Verificar WhatsApp\" e envie o código aqui."
)
HELP_MESSAGE = (
    "Posso registrar seus lançamentos! Ex.: 'gastei 100 no mercado' ou "
    "'recebi 5000 de salário'. Você também pode pedir um resumo."
)
#: Quando ativa, ``respond`` acumula o texto aqui em vez de enviar. Só o
#: ``process_job`` a ativa — ver a docstring dele.
_reply_outbox: ContextVar[list[str] | None] = ContextVar("reply_outbox", default=None)

AFFIRMATIVE = ("sim", "isso", "confirmo", "ok", "pode", "correto", "certo", "exato")
NEGATIVE = ("não", "nao", "cancela", "cancelar", "errado", "deixa")


def _normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    normalized = "".join(c for c in normalized if not unicodedata.combining(c))
    return normalized.lower().strip()


class MessageProcessor:
    async def process_job(self, job: ProcessingJobV1) -> str:
        """Processa um job consolidado vindo de ``whatsapp.processing.v1``.

        **Não envia a resposta: devolve o texto** para o consumer entregar com
        :meth:`deliver`. Calcular e entregar são separados porque o processamento
        tem efeitos que não se repetem com segurança — a confirmação pendente é
        apagada ao criar o lançamento, e um "sim" reprocessado seria classificado
        do zero, sem a pergunta. Se só a entrega falhar, o retry reenvia o texto
        guardado em vez de refazer o job.

        O ``jobId`` vira a chave de idempotência da criação do lançamento: um
        retry após timeout não cria um segundo lançamento.
        """
        outbox: list[str] = []
        token = _reply_outbox.set(outbox)
        try:
            await self._process(
                phone=job.phone,
                message=job.combined_message.strip(),
                source_message_ids=job.source_message_ids,
                idempotency_key=job.job_id,
                response_prefix=job.response_prefix,
                pre_extracted=job.pre_extracted_intent,
                force_confirm=job.force_confirm,
                confirm_question=job.confirm_question,
            )
        finally:
            _reply_outbox.reset(token)
        # Todo ramo de `_process` responde uma única vez; juntar é só defesa.
        return "\n\n".join(outbox)

    async def process_buffered_message(
        self,
        phone: str,
        combined_message: str,
        source_message_ids: list[str] | None = None,
    ) -> str:
        """Caminho legado (``MESSAGE_PIPELINE=legacy``), sem broker.

        ``source_message_ids`` são os ids das ``AiMessage`` inbound já
        persistidas pelo buffer (a última é usada como origem da extração).
        """
        return await self._process(
            phone=phone,
            message=combined_message.strip(),
            source_message_ids=source_message_ids or [],
            idempotency_key=None,
        )

    async def _process(
        self,
        *,
        phone: str,
        message: str,
        source_message_ids: list[str],
        idempotency_key: str | None,
        response_prefix: str = "",
        pre_extracted: dict | None = None,
        force_confirm: bool = False,
        confirm_question: str | None = None,
    ) -> str:
        """Núcleo do processamento; devolve a resposta enviada ao usuário."""
        last_inbound_id = source_message_ids[-1] if source_message_ids else None

        metrics.incr("messages_processed")

        # Código de verificação do número: a API decide se confere. O código
        # com rótulo ("Código: 123456", como o app preenche) é conferido antes
        # do contato, porque o número que o envia ainda não é vinculado.
        code = extract_verification_code(message)
        if code is not None and code.labeled:
            outcome = await phone_verification_service.confirm(phone, code.value)
            if outcome.reply is not None:
                return await self._respond(phone, outcome.reply)

        contact = await contact_service.find_by_phone(phone)
        if contact is None:
            if code is not None and not code.labeled:
                # Número solto só vale como código para quem ainda não tem vínculo.
                outcome = await phone_verification_service.confirm(phone, code.value)
                if outcome.reply is not None:
                    return await self._respond(phone, outcome.reply)
            metrics.incr("not_linked")
            logger.info("Contato não vinculado")
            if code is not None:
                return await self._respond(phone, NO_PENDING_CODE_MESSAGE)
            return await self._respond(phone, NOT_LINKED_MESSAGE)
        if code is not None and code.labeled:
            # Código sem desafio aberto vindo de um número já vinculado (ex.:
            # reenvio da mesma mensagem). Não é um lançamento para o LLM.
            return await self._respond(phone, ALREADY_LINKED_MESSAGE)

        user_id = contact["userId"]

        # Bloqueia antes de qualquer operação paga (LLM/criação) se sem assinatura.
        allowed, block_message = await subscription_gate.evaluate(user_id)
        if not allowed:
            metrics.incr("subscription_blocked")
            logger.info("Acesso bloqueado por assinatura")
            return await self._respond(phone, block_message or NOT_LINKED_MESSAGE)

        # Depois do vínculo e da assinatura, antes de qualquer chamada paga. O
        # comprovante (intent pré-extraído) já foi contado no consumer de
        # entrada, onde a leitura da imagem aconteceu.
        if pre_extracted is None and not await usage_limiter.allow(phone):
            return await self._respond(phone, DAILY_LIMIT_MESSAGE)

        if pre_extracted is not None:
            # Comprovante: a visão já extraiu o intent no consumer de entrada.
            intent = FinancialIntent(**pre_extracted)
        else:
            state = await conversation_manager.get(phone)

            if state.awaiting_confirmation and not state.belongs_to(contact):
                # O número mudou de dono (ou foi revogado e reverificado) depois
                # da pergunta: a resposta não pode concluir o lançamento de outra
                # conta. Descarta e trata a mensagem como nova.
                metrics.incr("pending_discarded_link_changed")
                logger.info("Confirmação pendente descartada: vínculo do número mudou")
                await conversation_manager.clear(phone)
                state = ConversationState()

            if state.awaiting_confirmation and state.pending_intent is not None:
                context = await self._build_context(user_id, contact, phone)
                intent, confirmed = self._merge_confirmation_reply(
                    state.pending_intent, message, context
                )
                if confirmed is False:  # usuário cancelou
                    await conversation_manager.clear(phone)
                    return await self._respond(phone, "Ok, cancelei. Nada foi registrado.")
            else:
                context = await self._build_context(user_id, contact, phone)
                intent = await intent_classifier.classify(message, context)

        return await self.handle_intent(
            phone,
            user_id,
            intent,
            message,
            last_inbound_id,
            response_prefix=response_prefix,
            force_confirm=force_confirm,
            confirm_question=confirm_question,
            idempotency_key=idempotency_key,
            contact=contact,
        )

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
        idempotency_key: str | None = None,
        contact: dict | None = None,
    ) -> str:
        """Trata um ``FinancialIntent`` já extraído (texto, áudio ou imagem).

        ``response_prefix`` é prefixado na resposta final (ex.: eco da transcrição
        de áudio). ``force_confirm`` força o ramo de confirmação independentemente
        das regras (usado para comprovantes/imagem). ``contact`` é o vínculo que
        fica gravado junto de uma confirmação pendente.
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
            await conversation_manager.set_pending(phone, intent, contact)
            await audit_service.log_extraction(
                user_id=user_id,
                raw_input=raw_message,
                extracted_payload=intent.model_dump(mode="json"),
                confidence=intent.confidence,
                status="pending",
                source_message_id=last_inbound_id,
                idempotency_key=idempotency_key,
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
            idempotency_key=idempotency_key,
        )

        result = await transaction_creator.create_from_intent(
            intent,
            user_id,
            raw_message,
            ai_extracted_transaction_id=extraction_id,
            idempotency_key=idempotency_key,
        )
        await conversation_manager.clear(phone)

        metrics.incr("transactions_created" if result.get("ok") else "transaction_failed")

        return await self._respond(phone, response_prefix + result["message"])

    async def respond(self, phone: str, text: str) -> str:
        """Envia a resposta ao usuário — ou a guarda, dentro de ``process_job``."""
        outbox = _reply_outbox.get()
        if outbox is not None:
            outbox.append(text)
            return text
        return await self.deliver(phone, text)

    async def deliver(self, phone: str, text: str) -> str:
        """Entrega ao usuário e registra como outbound. **Levanta** se não entregar."""
        try:
            await messenger.send(phone, text)
        except Exception:  # noqa: BLE001 — conta e propaga: quem chama decide
            metrics.incr("whatsapp_send_failed")
            logger.exception("Falha ao enviar resposta pelo WhatsApp")
            raise
        await audit_service.log_message(phone, "outbound", text)
        return text

    # Mantido para compatibilidade com chamadores existentes.
    async def _respond(self, phone: str, text: str) -> str:
        return await self.respond(phone, text)

    def _merge_confirmation_reply(
        self, pending: FinancialIntent, reply: str, context: dict | None = None
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
        elif pending.category_name is None:
            matched_category = self._match_category_reply(reply, context or {})
            if matched_category is not None:
                pending.category_name = matched_category
        if extracted.transaction_date is not None and "hoje" not in reply.lower():
            pending.transaction_date = extracted.transaction_date

        confirmed: bool | None = None
        if any(word in text for word in AFFIRMATIVE):
            confirmed = True

        # Resposta complementar (ex.: nome de categoria) eleva a confiança.
        pending.confidence = max(pending.confidence, settings.confidence_threshold)
        pending.needs_confirmation = False
        return pending, confirmed

    def _match_category_reply(self, reply: str, context: dict) -> str | None:
        """Resolve respostas curtas de confirmação contra categorias reais."""
        target = _normalize_text(reply)
        if not target:
            return None

        categories = context.get("categories") or []
        for category in categories:
            normalized = _normalize_text(str(category))
            if normalized == target:
                return str(category)

        for category in categories:
            normalized = _normalize_text(str(category))
            if target in normalized or normalized in target:
                return str(category)

        return None

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
            "today": today_local().isoformat(),
            "categories": categories,
            "accounts": accounts,
            "profile_type": contact.get("profileType"),
            "recent_messages": recent_messages,
            "current_message": None,  # preenchido pelo classificador com a mensagem atual
        }


message_processor = MessageProcessor()
