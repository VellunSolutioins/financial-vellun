import hashlib
import hmac
import logging
from datetime import date

from fastapi import APIRouter, Header, HTTPException, Request

from ..config import settings
from ..schemas.financial_intent import FinancialIntent, IntentType
from ..schemas.webhook import WhatsappWebhookPayload
from ..services.audit_service import audit_service
from ..services.confirmation_rules import needs_confirmation
from ..services.contact_service import contact_service
from ..services.conversation_manager import conversation_manager
from ..services.intent_classifier import intent_classifier
from ..services.messenger import messenger
from ..services.transaction_creator import transaction_creator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhook", tags=["webhook"])

NOT_LINKED_MESSAGE = (
    "Seu número não está vinculado a uma conta. Acesse o app para vincular."
)
HELP_MESSAGE = (
    "Posso registrar seus lançamentos! Ex.: 'gastei 100 no mercado' ou "
    "'recebi 5000 de salário'. Você também pode pedir um resumo."
)
AFFIRMATIVE = ("sim", "isso", "confirmo", "ok", "pode", "correto", "certo", "exato")
NEGATIVE = ("não", "nao", "cancela", "cancelar", "errado", "deixa")


def _verify_signature(raw_body: bytes, signature: str | None) -> bool:
    """Valida assinatura HMAC-SHA256. Sem secret configurado, aceita (MVP)."""
    if not settings.whatsapp_webhook_secret:
        return True
    if not signature:
        return False
    expected = hmac.new(
        settings.whatsapp_webhook_secret.encode(), raw_body, hashlib.sha256
    ).hexdigest()
    provided = signature.removeprefix("sha256=")
    return hmac.compare_digest(expected, provided)


@router.post("/whatsapp")
async def receive_whatsapp(
    request: Request,
    x_webhook_signature: str | None = Header(default=None),
) -> dict:
    raw_body = await request.body()
    if not _verify_signature(raw_body, x_webhook_signature):
        raise HTTPException(status_code=401, detail="Assinatura inválida")

    try:
        payload = WhatsappWebhookPayload.model_validate_json(raw_body)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Payload inválido") from exc

    reply = await _process_message(payload)
    await messenger.send(payload.phone, reply)
    # 200 imediato; resposta incluída no corpo para facilitar testes.
    return {"status": "ok", "reply": reply}


async def _process_message(payload: WhatsappWebhookPayload) -> str:
    phone, message = payload.phone, payload.message

    contact = await contact_service.find_by_phone(phone)
    if contact is None:
        logger.info("Contato não vinculado: %s", phone)
        return NOT_LINKED_MESSAGE

    user_id = contact["userId"]

    # Registra a mensagem recebida.
    inbound_message_id = await audit_service.log_message(phone, "inbound", message)

    state = conversation_manager.get(phone)

    if state.awaiting_confirmation and state.pending_intent is not None:
        intent, confirmed = _merge_confirmation_reply(state.pending_intent, message)
        if confirmed is False:  # usuário cancelou
            conversation_manager.clear(phone)
            reply = "Ok, cancelei. Nada foi registrado."
            await audit_service.log_message(phone, "outbound", reply)
            return reply
    else:
        context = await _build_context(user_id, contact)
        intent = await intent_classifier.classify(message, context)

    # Intenções não-transacionais.
    if intent.intent == IntentType.help:
        await audit_service.log_message(phone, "outbound", HELP_MESSAGE)
        return HELP_MESSAGE
    if intent.intent == IntentType.query_summary:
        reply = "Consulta de resumo via WhatsApp ainda não está disponível. Veja no app."
        await audit_service.log_message(phone, "outbound", reply)
        return reply
    if intent.intent in (IntentType.cancel_last, IntentType.correct_last):
        reply = "Para corrigir ou cancelar um lançamento, use o app por enquanto."
        await audit_service.log_message(phone, "outbound", reply)
        return reply

    must_confirm, question = needs_confirmation(intent, message)

    if must_confirm:
        conversation_manager.set_pending(phone, intent)
        await audit_service.log_extraction(
            user_id=user_id,
            raw_input=message,
            extracted_payload=intent.model_dump(mode="json"),
            confidence=intent.confidence,
            status="pending",
            source_message_id=inbound_message_id,
        )
        await audit_service.log_message(phone, "outbound", question)
        return question

    # Pronto para criar: registra a extração e cria o lançamento.
    extraction_id = await audit_service.log_extraction(
        user_id=user_id,
        raw_input=message,
        extracted_payload=intent.model_dump(mode="json"),
        confidence=intent.confidence,
        status="confirmed",
        source_message_id=inbound_message_id,
    )

    result = await transaction_creator.create_from_intent(
        intent, user_id, message, ai_extracted_transaction_id=extraction_id
    )
    conversation_manager.clear(phone)

    await audit_service.log_message(phone, "outbound", result["message"])
    return result["message"]


def _merge_confirmation_reply(
    pending: FinancialIntent, reply: str
) -> tuple[FinancialIntent, bool | None]:
    """Funde a resposta do usuário ao intent pendente.

    Retorna ``(intent, confirmed)`` onde ``confirmed`` é ``False`` se o usuário
    negou, ``True`` se confirmou explicitamente, ``None`` caso indefinido.
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


async def _build_context(user_id: str, contact: dict) -> dict:
    """Contexto para o LLM: categorias, contas e data atual."""
    from ..services.api_client import api_client

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
        logger.warning("Não foi possível carregar contexto do usuário %s", user_id, exc_info=True)

    return {
        "today": date.today().isoformat(),
        "categories": categories,
        "accounts": accounts,
        "profile_type": contact.get("profileType"),
    }
