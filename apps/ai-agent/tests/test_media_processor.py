"""Testes do MediaProcessor: áudio, imagem (confirmação) e fallbacks."""

import asyncio

import src.services.media_processor as mpm
from src.schemas.financial_intent import FinancialIntent, IntentType, TransactionTypeEnum
from src.services.whatsapp_inbound import InboundMessage


class _FakeContact:
    def __init__(self, contact):
        self._contact = contact

    async def find_by_phone(self, phone):
        return self._contact


class _FakeMedia:
    def __init__(self, result):
        self._result = result

    async def fetch(self, media_id):
        return self._result


class _FakeTranscription:
    def __init__(self, text):
        self._text = text

    async def transcribe(self, content, mime):
        return self._text


class _FakeClassifier:
    def __init__(self, intent=None, image_intent=None):
        self._intent = intent
        self._image_intent = image_intent

    async def classify(self, message, context):
        return self._intent

    async def classify_image(self, content, mime, caption, context):
        return self._image_intent


class _FakeAudit:
    def __init__(self, duplicate=False):
        self._duplicate = duplicate

    async def log_message_detailed(self, *a, **k):
        return {"duplicate": True} if self._duplicate else {"id": "in1"}


class _FakeProcessor:
    def __init__(self):
        self.responded: list[str] = []
        self.handle_calls: list[dict] = []

    async def _respond(self, phone, text):
        self.responded.append(text)
        return text

    async def _build_context(self, user_id, contact, phone):
        return {}

    async def handle_intent(
        self, phone, user_id, intent, raw, last_inbound_id=None,
        *, response_prefix="", force_confirm=False, confirm_question=None,
    ):
        self.handle_calls.append(
            {
                "raw": raw,
                "response_prefix": response_prefix,
                "force_confirm": force_confirm,
                "confirm_question": confirm_question,
                "last_inbound_id": last_inbound_id,
            }
        )
        if force_confirm:
            return response_prefix + (confirm_question or "Confirma?")
        return response_prefix + "Lançamento criado!"


def _patch(**overrides):
    originals = {name: getattr(mpm, name) for name in overrides}
    for name, value in overrides.items():
        setattr(mpm, name, value)
    return originals


def _restore(originals):
    for name, value in originals.items():
        setattr(mpm, name, value)


def _run(contact, media, *, transcription=None, classifier=None, audit=None, processor=None,
         item=None):
    processor = processor or _FakeProcessor()
    originals = _patch(
        contact_service=_FakeContact(contact),
        whatsapp_media=_FakeMedia(media),
        transcription_service=transcription or _FakeTranscription(None),
        intent_classifier=classifier or _FakeClassifier(),
        audit_service=audit or _FakeAudit(),
        message_processor=processor,
    )
    try:
        reply = asyncio.run(mpm.media_processor.process("+5511", item))
    finally:
        _restore(originals)
    return reply, processor


def _expense_intent():
    return FinancialIntent(
        intent=IntentType.create_transaction,
        transaction_type=TransactionTypeEnum.expense,
        amount=100.0,
        category_name="Mercado",
        transaction_date="2026-06-19",
        confidence=0.9,
    )


def test_audio_creates_and_echoes_transcription():
    item = InboundMessage(phone="+5511", kind="audio", media_id="m1", message_id="wamid.A")
    reply, proc = _run(
        contact={"userId": "u1", "profileType": "personal"},
        media=(b"audio-bytes", "audio/ogg"),
        transcription=_FakeTranscription("gastei 100 no mercado"),
        classifier=_FakeClassifier(intent=_expense_intent()),
        item=item,
    )
    assert len(proc.handle_calls) == 1
    call = proc.handle_calls[0]
    assert call["force_confirm"] is False
    assert call["raw"] == "gastei 100 no mercado"
    assert 'Entendi: "gastei 100 no mercado".' in call["response_prefix"]
    assert "Lançamento criado!" in reply


def test_image_asks_for_confirmation():
    item = InboundMessage(phone="+5511", kind="image", media_id="img1", message_id="wamid.I")
    reply, proc = _run(
        contact={"userId": "u1", "profileType": "personal"},
        media=(b"img-bytes", "image/jpeg"),
        classifier=_FakeClassifier(image_intent=_expense_intent()),
        item=item,
    )
    assert len(proc.handle_calls) == 1
    call = proc.handle_calls[0]
    assert call["force_confirm"] is True
    assert "Confirma o lançamento?" in call["confirm_question"]
    assert "R$ 100.00" in call["confirm_question"]


def test_audio_transcription_failure_returns_fallback():
    item = InboundMessage(phone="+5511", kind="audio", media_id="m1")
    reply, proc = _run(
        contact={"userId": "u1"},
        media=(b"audio", "audio/ogg"),
        transcription=_FakeTranscription(None),
        item=item,
    )
    assert reply == mpm.AUDIO_FALLBACK
    assert proc.handle_calls == []


def test_image_vision_unavailable_returns_fallback():
    item = InboundMessage(phone="+5511", kind="image", media_id="img1")
    reply, proc = _run(
        contact={"userId": "u1"},
        media=(b"img", "image/jpeg"),
        classifier=_FakeClassifier(image_intent=None),
        item=item,
    )
    assert reply == mpm.IMAGE_FALLBACK
    assert proc.handle_calls == []


def test_download_failure_returns_fallback():
    item = InboundMessage(phone="+5511", kind="audio", media_id="m1")
    reply, proc = _run(contact={"userId": "u1"}, media=None, item=item)
    assert reply == mpm.DOWNLOAD_FALLBACK


def test_not_linked_contact():
    item = InboundMessage(phone="+5511", kind="audio", media_id="m1")
    reply, proc = _run(contact=None, media=(b"x", "audio/ogg"), item=item)
    assert reply == mpm.NOT_LINKED_MESSAGE
