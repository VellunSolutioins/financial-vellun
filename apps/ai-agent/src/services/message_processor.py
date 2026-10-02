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
from dataclasses import dataclass
from datetime import date, datetime

from ..config import settings
from ..messaging.contracts import ProcessingJobV1
from ..schemas.financial_intent import (
    AccountKindEnum,
    FinancialIntent,
    IntentType,
    RecurrenceTypeEnum,
)
from . import reply_parsers as parsers
from .audit_service import audit_service
from .clock import local_date, today_local
from .confirmation_rules import (
    FIELD_ACCOUNT,
    FIELD_AMOUNT,
    FIELD_AMOUNT_BASIS,
    FIELD_CATEGORY,
    FIELD_CONFIRM,
    FIELD_DATE,
    FIELD_FREQUENCY,
    FIELD_INSTALLMENTS,
    FIELD_OCCURRENCES,
    FIELD_TYPE,
    MAX_INSTALLMENTS,
    MAX_OCCURRENCES,
    MIN_INSTALLMENTS,
    MIN_OCCURRENCES,
    Question,
    format_brl,
    next_question,
    total_amount,
)
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
    "Posso registrar seus lançamentos! Ex.: 'gastei 100 no mercado' (já pago) ou "
    "'conta de luz de 180 vence dia 10' (fica em aberto até você pagar)."
)
#: Quando ativa, ``respond`` acumula o texto aqui em vez de enviar. Só o
#: ``process_job`` a ativa — ver a docstring dele.
_reply_outbox: ContextVar[list[str] | None] = ContextVar("reply_outbox", default=None)

#: Preenchido com ``{"userId", "contactId"}`` assim que o contato é resolvido,
#: para o consumer de processamento anexar identidade à mensagem de saída sem
#: consultar de novo. Quem abre o slot é o **chamador** (o consumer), e não este
#: módulo: assim um dublê de ``process_job`` num teste simplesmente não o
#: preenche, em vez de quebrar.
job_identity: ContextVar[dict[str, str | None] | None] = ContextVar(
    "job_identity", default=None
)

NOT_UNDERSTOOD_MESSAGE = (
    "Não entendi. Para registrar um lançamento, mande algo como 'gastei 50 no mercado' "
    "ou 'recebi 5000 de salário'."
)
#: Transferência entre contas próprias, empréstimo, aporte ou resgate: não é
#: receita nem despesa (docs/adrs/0018). Registrar como uma das duas distorceria
#: os números, então o agente orienta a usar "Transferir" no app.
UNSUPPORTED_MOVEMENT_MESSAGE = (
    "Transferência entre suas contas, empréstimo, aporte ou resgate não é receita nem "
    "despesa, então não registro pelo WhatsApp. No app, use Lançamentos › Transferir. "
    "Juros e tarifas você pode mandar aqui como gasto."
)
NO_PENDING_MESSAGE = (
    "Não há lançamento aguardando confirmação. Para registrar, mande algo como "
    "'gastei 50 no mercado'."
)
CANCELLED_MESSAGE = "Ok, cancelei. Nada foi registrado."
GAVE_UP_MESSAGE = (
    "Não consegui entender a resposta, então deixei esse lançamento de lado. "
    "Pode mandar de novo quando quiser."
)
#: Respostas seguidas que não respondem à pergunta antes de desistir.
MAX_REPLY_ATTEMPTS = 2

# Desfechos da fusão de uma resposta com o lançamento pendente.
MERGED = "merged"
CANCELLED = "cancelled"
UNPARSED = "unparsed"
NEW_MESSAGE = "new_message"


@dataclass
class MergeResult:
    intent: FinancialIntent
    outcome: str
    #: Texto da nova pergunta, quando a resposta não serviu (``UNPARSED``).
    retry_question: str | None = None


def _normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    normalized = "".join(c for c in normalized if not unicodedata.combining(c))
    return normalized.lower().strip()


def _parse_iso_date(value: str | None) -> date | None:
    try:
        return date.fromisoformat(value) if value else None
    except ValueError:
        return None


def _reference_of(context: dict) -> date:
    """"Hoje" da conversa: a data gravada no contexto, ou o dia atual."""
    return _parse_iso_date(context.get("today")) or today_local()


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
                received_at=job.first_received_at,
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
        received_at: datetime | None = None,
    ) -> str:
        """Núcleo do processamento; devolve a resposta enviada ao usuário.

        ``received_at`` é quando a mensagem chegou: o dia dela é o "hoje" do
        lançamento, mesmo que o processamento aconteça depois da meia-noite.
        """
        last_inbound_id = source_message_ids[-1] if source_message_ids else None
        reference = local_date(received_at)

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
        slot = job_identity.get()
        if slot is not None:
            slot["userId"] = user_id
            slot["contactId"] = contact.get("contactId")

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

        original_message: str | None = None
        confirmed_amount: float | None = None
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

            context = dict(await self._build_context(user_id, contact, phone))
            if state.awaiting_confirmation and state.pending_intent is not None:
                # "Ontem" numa resposta é relativo ao dia da mensagem original.
                pending_reference = _parse_iso_date(state.reference_date) or reference
                context["today"] = pending_reference.isoformat()
                result = self._merge_confirmation_reply(state, message, context)

                if result.outcome == CANCELLED:
                    await conversation_manager.clear(phone)
                    return await self._respond(phone, response_prefix + CANCELLED_MESSAGE)

                if result.outcome == UNPARSED:
                    return await self._ask_again(phone, state, result, response_prefix)

                if result.outcome == NEW_MESSAGE:
                    # Um lançamento novo no meio da pergunta: antes ele virava a
                    # resposta e sobrescrevia o valor do pendente.
                    metrics.incr("pending_replaced_by_new_message")
                    await conversation_manager.clear(phone)
                    response_prefix = (
                        self._discarded_notice(state.pending_intent) + response_prefix
                    )
                    context["today"] = reference.isoformat()
                    intent = await intent_classifier.classify(message, context)
                else:
                    intent = result.intent
                    original_message = state.original_message
                    reference = pending_reference
                    # O "sim" a uma confirmação vale para o total que ela mostrou;
                    # se uma resposta seguinte mudar o valor, pergunta de novo.
                    confirmed_amount = (
                        total_amount(intent)
                        if state.awaiting_field == FIELD_CONFIRM
                        else state.confirmed_amount
                    )
            else:
                context["today"] = reference.isoformat()
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
            original_message=original_message,
            reference_date=reference,
            confirmed_amount=confirmed_amount,
        )

    async def _ask_again(
        self, phone: str, state: ConversationState, result: MergeResult, response_prefix: str
    ) -> str:
        """A resposta não respondeu à pergunta: repete (com a dica), até desistir."""
        attempts = state.attempts + 1
        if attempts > MAX_REPLY_ATTEMPTS:
            metrics.incr("pending_abandoned")
            await conversation_manager.clear(phone)
            return await self._respond(phone, response_prefix + GAVE_UP_MESSAGE)
        metrics.incr("pending_reply_unparsed")
        await conversation_manager.set_pending(
            phone,
            result.intent,
            {
                "userId": state.user_id,
                "contactId": state.contact_id,
                "linkVersion": state.link_version,
            },
            awaiting_field=state.awaiting_field,
            original_message=state.original_message,
            reference_date=state.reference_date,
            attempts=attempts,
            confirmed_amount=state.confirmed_amount,
        )
        return await self._respond(phone, response_prefix + (result.retry_question or ""))

    @staticmethod
    def _discarded_notice(pending: FinancialIntent | None) -> str:
        what = ""
        if pending is not None and pending.amount:
            what = f" de {format_brl(pending.amount)}"
            if pending.description:
                what += f" ({pending.description})"
        return f"Deixei de lado o lançamento anterior{what}, que aguardava resposta.\n"

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
        original_message: str | None = None,
        reference_date: date | None = None,
        confirmed_amount: float | None = None,
    ) -> str:
        """Trata um ``FinancialIntent`` já extraído (texto, áudio ou imagem).

        ``response_prefix`` é prefixado na resposta final (ex.: eco da transcrição
        de áudio). ``force_confirm`` força o ramo de confirmação independentemente
        das regras (usado para comprovantes/imagem). ``contact`` é o vínculo que
        fica gravado junto de uma confirmação pendente.

        ``raw_message`` é o texto recebido agora; ``original_message``, a
        mensagem que abriu o lançamento, quando ele veio sendo completado por
        respostas. ``reference_date`` é o dia dessa mensagem.
        ``confirmed_amount`` é o total que o usuário já confirmou com "sim".
        """
        original = original_message or raw_message
        reference = reference_date or today_local()
        # Intenções não-transacionais.
        if intent.intent == IntentType.help:
            return await self._respond(phone, response_prefix + HELP_MESSAGE)
        if intent.intent == IntentType.query_summary:
            return await self._respond(
                phone,
                response_prefix
                + "Consulta de resumo via WhatsApp ainda não está disponível. Veja no app.",
            )
        if intent.intent == IntentType.unsupported_movement:
            metrics.incr("intent_unsupported_movement")
            return await self._respond(phone, response_prefix + UNSUPPORTED_MOVEMENT_MESSAGE)
        if intent.intent in (IntentType.cancel_last, IntentType.correct_last):
            return await self._respond(
                phone,
                response_prefix
                + "Para corrigir ou cancelar um lançamento, use o app por enquanto.",
            )

        without_transaction = (IntentType.unknown, IntentType.confirmation_reply)
        if not force_confirm and intent.intent in without_transaction:
            if intent.amount is None or intent.amount <= 0:
                # Sem valor não há lançamento para completar: antes a mensagem
                # ("oi") caía na criação e virava "Não identifiquei o valor…".
                metrics.incr("intent_not_understood")
                reply = (
                    NO_PENDING_MESSAGE
                    if intent.intent == IntentType.confirmation_reply
                    else NOT_UNDERSTOOD_MESSAGE
                )
                return await self._respond(phone, response_prefix + reply)
            intent.intent = IntentType.create_transaction

        question: Question | None
        if force_confirm:
            question = Question(FIELD_CONFIRM, confirm_question or "Confirma o lançamento?")
        else:
            question = next_question(intent, raw_message, confirmed_total=confirmed_amount)
            if question is None:
                # Conta/cartão e categoria dependem do catálogo do usuário.
                question = await transaction_creator.pending_question(intent, user_id)

        if question is not None:
            metrics.incr("confirmation_requested")
            await conversation_manager.set_pending(
                phone,
                intent,
                contact,
                awaiting_field=question.field,
                original_message=original,
                reference_date=reference.isoformat(),
                confirmed_amount=confirmed_amount,
            )
            await audit_service.log_extraction(
                user_id=user_id,
                raw_input=original,
                extracted_payload=intent.model_dump(mode="json"),
                confidence=intent.confidence,
                status="pending",
                source_message_id=last_inbound_id,
                idempotency_key=idempotency_key,
            )
            return await self._respond(phone, response_prefix + question.text)

        # Pronto para criar: registra a extração e cria o lançamento.
        extraction_id = await audit_service.log_extraction(
            user_id=user_id,
            raw_input=original,
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
            reference_date=reference,
            original_message=original,
        )
        await conversation_manager.clear(phone)

        metrics.incr("transactions_created" if result.get("ok") else "transaction_failed")

        return await self._respond(phone, response_prefix + result["message"])

    async def respond(self, phone: str, text: str) -> str:
        """Responde ao usuário — ou guarda o texto, dentro de ``process_job``.

        Fora de um job (avisos do consumer de entrada, caminho legado), a
        resposta vai para o despachante de saída, que enfileira ou entrega
        conforme ``OUTBOUND_DELIVERY``. Nenhum ponto do domínio chama o
        messenger direto.
        """
        outbox = _reply_outbox.get()
        if outbox is not None:
            outbox.append(text)
            return text

        from .outbound import outbound_dispatcher

        await outbound_dispatcher.send(phone, text, kind="notice")
        return text

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
        self, state: ConversationState, reply: str, context: dict | None = None
    ) -> MergeResult:
        """Funde a resposta do usuário ao lançamento pendente.

        A pergunta gravada diz qual campo a resposta preenche (``awaiting_field``):
        "10" é número de parcelas se a pergunta foi "Em quantas parcelas?". Só
        esse campo muda — antes a resposta passava pelas regras inteiras, e um
        "sim" trocava a data do lançamento pela de hoje.
        """
        context = context or {}
        pending = (state.pending_intent or FinancialIntent()).model_copy(deep=True)
        field = state.awaiting_field

        if field is None:  # estado v2: confirmação genérica
            return self._merge_generic(pending, reply, context)

        if field not in (FIELD_AMOUNT, FIELD_CONFIRM) and self._looks_like_new_transaction(
            reply, pending
        ):
            return MergeResult(pending, NEW_MESSAGE)

        if field == FIELD_CONFIRM:
            if parsers.is_negative(reply):
                return MergeResult(pending, CANCELLED)
            if parsers.is_affirmative(reply) or self._apply_corrections(pending, reply, context):
                return self._merged(pending)
            return MergeResult(
                pending, UNPARSED, "Não entendi. Confirma o lançamento? Responda sim ou não."
            )

        applied, retry = self._apply_field(pending, field, reply, context)
        if applied:
            return self._merged(pending)
        if parsers.is_negative(reply):
            return MergeResult(pending, CANCELLED)
        return MergeResult(pending, UNPARSED, retry)

    @staticmethod
    def _merged(pending: FinancialIntent) -> MergeResult:
        # O usuário completou o que faltava: a baixa confiança da extração
        # original não deve gerar mais uma pergunta de confirmação.
        pending.confidence = max(pending.confidence, settings.confidence_threshold)
        pending.needs_confirmation = False
        return MergeResult(pending, MERGED)

    def _apply_field(
        self, pending: FinancialIntent, field: str, reply: str, context: dict
    ) -> tuple[bool, str]:
        """Preenche ``field`` com a resposta. Devolve ``(preencheu, pergunta_de_novo)``."""
        reference = _reference_of(context)

        if field == FIELD_AMOUNT:
            amount = parsers.parse_amount(reply)
            if amount is not None:
                pending.amount = amount
                if pending.transaction_type is None:
                    pending.transaction_type = parsers.parse_type(reply)
            return amount is not None, "Não entendi o valor. Qual foi o valor? (ex.: 47,50)"

        if field == FIELD_TYPE:
            tx_type = parsers.parse_type(reply)
            if tx_type is not None:
                pending.transaction_type = tx_type
            return tx_type is not None, "É uma receita ou uma despesa?"

        if field == FIELD_DATE:
            parsed = parsers.parse_date(reply, reference)
            if parsed is not None:
                pending.transaction_date = parsed.isoformat()
            return parsed is not None, "Não entendi a data. Qual foi o dia? (ex.: 17/06/2026)"

        if field == FIELD_CATEGORY:
            category = self._match_category_reply(reply, context, pending)
            if category is not None:
                pending.category_name = category
            return category is not None, (
                "Não encontrei essa categoria. Responda com um dos nomes da lista."
            )

        if field == FIELD_ACCOUNT:
            return self._apply_account(pending, reply, context)

        if field == FIELD_INSTALLMENTS:
            words = set(parsers.tokens(reply))
            count = parsers.parse_int(reply)
            if count == 1 or {"vista", "avista"} & words:
                # "À vista": não é parcelado.
                pending.recurrence_type = RecurrenceTypeEnum.avulso
                pending.installments = None
                pending.amount_basis = None
                return True, ""
            if count is not None and MIN_INSTALLMENTS <= count <= MAX_INSTALLMENTS:
                pending.installments = count
                if pending.amount_basis is None:
                    pending.amount_basis = parsers.parse_amount_basis(reply)
                return True, ""
            return False, "O parcelamento aceita de 2 a 72 parcelas. Em quantas parcelas foi?"

        if field == FIELD_AMOUNT_BASIS:
            basis = parsers.parse_amount_basis(reply)
            if basis is not None:
                pending.amount_basis = basis
            return basis is not None, (
                "Responda 'total' se o valor é o da compra inteira, ou 'parcela' se é o "
                "de cada parcela."
            )

        if field == FIELD_FREQUENCY:
            frequency = parsers.parse_frequency(reply)
            if frequency is not None:
                pending.recurrence_frequency = frequency
                if pending.occurrences is None and (
                    occurrences := parsers.parse_occurrences(reply, frequency)
                ):
                    pending.occurrences = (
                        occurrences if MIN_OCCURRENCES <= occurrences <= MAX_OCCURRENCES else None
                    )
                return True, ""
            if parsers.mentions_unsupported_frequency(reply):
                return False, (
                    "Por enquanto, lançamentos fixos podem ser mensais, bimestrais, "
                    "semestrais ou anuais. Qual dessas?"
                )
            return False, "Com que frequência ele se repete? Mensal, bimestral, semestral ou anual?"

        if field == FIELD_OCCURRENCES:
            occurrences = parsers.parse_occurrences(reply, pending.recurrence_frequency)
            if occurrences is not None and MIN_OCCURRENCES <= occurrences <= MAX_OCCURRENCES:
                pending.occurrences = occurrences
                return True, ""
            return False, "O lançamento fixo aceita de 2 a 120 repetições. Quantas vezes?"

        logger.warning("Campo pendente desconhecido: %s", field)
        return self._apply_corrections(pending, reply, context), ""

    @staticmethod
    def _apply_account(pending: FinancialIntent, reply: str, context: dict) -> tuple[bool, str]:
        """Resposta à pergunta de conta/cartão: casa com os nomes do catálogo.

        Conta e cartão podem ter o mesmo nome; "cartão"/"crédito" ou
        "conta"/"débito" na resposta desempata.
        """
        from .transaction_creator import CARD_SUFFIX

        options = []
        for display in context.get("accounts") or []:
            is_card = display.endswith(CARD_SUFFIX)
            base = display[: -len(CARD_SUFFIX)] if is_card else display
            options.append((display, base, is_card))

        words = set(parsers.tokens(reply))
        wants_card = bool(words & {"cartao", "credito"})
        wants_account = bool(words & {"conta", "debito"})
        pool = [
            o for o in options if not (wants_card and not o[2]) and not (wants_account and o[2])
        ]

        matches = [pool[i] for i in parsers.match_names(reply, [o[1] for o in pool])]
        if not matches and wants_card and sum(1 for o in pool if o[2]) == 1:
            matches = [o for o in pool if o[2]]  # "no cartão", e só existe um

        if len(matches) == 1:
            display, _, is_card = matches[0]
            pending.account_name = display
            pending.account_kind = AccountKindEnum.card if is_card else AccountKindEnum.account
            return True, ""
        if len(matches) > 1:
            names = ", ".join(o[0] for o in matches)
            return False, f"Qual destas? {names}"
        return False, "Não encontrei essa conta ou cartão. Responda com um dos nomes da lista."

    def _apply_corrections(self, pending: FinancialIntent, reply: str, context: dict) -> bool:
        """Correções explícitas numa resposta de confirmação ("sim, mas foi 45")."""
        changed = False
        amount = parsers.parse_amount(reply)
        if amount is not None:
            pending.amount, changed = amount, True
        parsed_date = parsers.parse_date(reply, _reference_of(context))
        if parsed_date is not None:
            pending.transaction_date, changed = parsed_date.isoformat(), True
        return changed

    def _merge_generic(
        self, pending: FinancialIntent, reply: str, context: dict
    ) -> MergeResult:
        """Estado v2, sem o campo esperado: preenche o que a resposta trouxer."""
        if parsers.is_negative(reply):
            return MergeResult(pending, CANCELLED)

        amount = parsers.parse_amount(reply)
        if amount is not None:
            pending.amount = amount
        tx_type = parsers.parse_type(reply)
        if tx_type is not None:
            pending.transaction_type = tx_type
        if pending.category_name is None:
            matched_category = self._match_category_reply(reply, context, pending)
            if matched_category is not None:
                pending.category_name = matched_category
        # Só uma data **dita** na resposta: o padrão "hoje" das regras
        # sobrescrevia a data do lançamento a cada "sim".
        parsed_date = parsers.parse_date(reply, _reference_of(context))
        if parsed_date is not None:
            pending.transaction_date = parsed_date.isoformat()
        return self._merged(pending)

    @staticmethod
    def _looks_like_new_transaction(reply: str, pending: FinancialIntent) -> bool:
        """A mensagem é um lançamento novo, e não a resposta à pergunta.

        Valor e verbo de gasto/receita próprios, com um valor diferente do
        pendente ("gastei 50 no uber" enquanto a pergunta era a categoria).
        """
        amount = parsers.parse_amount(reply)
        return (
            amount is not None
            and parsers.parse_type(reply) is not None
            and amount != pending.amount
        )

    def _match_category_reply(
        self, reply: str, context: dict, pending: FinancialIntent | None = None
    ) -> str | None:
        """Resolve respostas curtas de confirmação contra categorias reais.

        Com o tipo do lançamento conhecido, só categorias desse tipo.
        """
        target = _normalize_text(reply)
        if not target:
            return None

        categories = context.get("categories") or []
        if pending is not None and pending.transaction_type is not None:
            typed_key = f"{pending.transaction_type.value}_categories"
            if typed_key in context:
                categories = context.get(typed_key) or []
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
        """Contexto para o LLM: categorias, contas, data e histórico recente.

        As listas vêm do ``user_catalog``, que as memoriza pelo tempo do job: a
        criação do lançamento precisa das mesmas duas, e antes cada uma era
        buscada duas vezes por mensagem.
        """
        from ..services.conversation_history_service import conversation_history_service
        from ..services.user_catalog import user_catalog

        catalog = await user_catalog.categories(user_id)
        from ..services.transaction_creator import display_name

        # Separadas por tipo: sem isso o LLM escolhia uma categoria de receita
        # para uma despesa. Sem `type` (API antiga), a categoria vale para os dois.
        def of_type(tx_type: str) -> list[str]:
            return [c["name"] for c in catalog if c.get("type") in (None, tx_type)]

        # Cartões entram na mesma lista, marcados, para o LLM distinguir
        # "paguei no Nubank" (cartão) de "saiu da conta do Nubank".
        accounts = [display_name(a) for a in await user_catalog.accounts(user_id)]

        recent_messages = await conversation_history_service.get_recent_messages(
            phone, settings.conversation_context_message_limit
        )

        return {
            "today": today_local().isoformat(),
            "categories": [c["name"] for c in catalog],
            "expense_categories": of_type("expense"),
            "income_categories": of_type("income"),
            "accounts": accounts,
            "profile_type": contact.get("profileType"),
            "recent_messages": recent_messages,
            "current_message": None,  # preenchido pelo classificador com a mensagem atual
        }


message_processor = MessageProcessor()
