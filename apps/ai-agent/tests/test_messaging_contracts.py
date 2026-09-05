"""Contratos de mensageria: validação, versão, correlação e nomes de fila."""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from src.messaging.contracts import (
    SCHEMA_VERSION,
    InboundMessageV1,
    ProcessingJobV1,
    derive_job_id,
)
from src.messaging.names import (
    all_retry_queues,
    base_name,
    dlq_queue,
    dlq_routing_key,
    retry_queue,
)
from src.services.phone import hash_phone, mask_phone, normalize_phone


# ── InboundMessageV1 ─────────────────────────────────────────────────────────
def test_serializa_em_camel_case_com_versao_e_correlacao():
    message = InboundMessageV1(phone="+5541999999999", text="oi", provider_message_id="wamid.1")

    payload = json.loads(message.to_json())

    assert payload["schemaVersion"] == SCHEMA_VERSION
    assert payload["providerMessageId"] == "wamid.1"
    assert payload["provider"] == "whatsapp-cloud-api"
    assert payload["correlationId"]
    assert payload["receivedAt"]


def test_desserializa_o_proprio_json():
    original = InboundMessageV1(phone="+5541999999999", text="oi")

    restaurada = InboundMessageV1.model_validate_json(original.to_json())

    assert restaurada.phone == original.phone
    assert restaurada.correlation_id == original.correlation_id


def test_texto_vazio_e_invalido():
    with pytest.raises(ValidationError):
        InboundMessageV1(phone="+5541999999999", kind="text", text="   ")


def test_midia_sem_referencia_e_invalida():
    with pytest.raises(ValidationError):
        InboundMessageV1(phone="+5541999999999", kind="audio")


def test_versao_desconhecida_e_recusada():
    with pytest.raises(ValidationError):
        InboundMessageV1.model_validate({"schemaVersion": 2, "phone": "+55", "text": "oi"})


def test_campo_desconhecido_e_recusado():
    with pytest.raises(ValidationError):
        InboundMessageV1.model_validate(
            {"phone": "+55", "text": "oi", "campoInesperado": True}
        )


def test_contrato_nao_transporta_binario():
    message = InboundMessageV1(phone="+55", kind="image", media_id="m1", media_mime="image/jpeg")

    payload = json.loads(message.to_json())

    assert payload["mediaId"] == "m1"
    assert all(not isinstance(value, (bytes, bytearray)) for value in payload.values())


# ── ProcessingJobV1 ──────────────────────────────────────────────────────────
def test_job_exige_conteudo_ou_intent():
    with pytest.raises(ValidationError):
        ProcessingJobV1(job_id="j1", phone="+55", combined_message="  ")


def test_job_com_intent_pre_extraido_dispensa_texto():
    job = ProcessingJobV1(
        job_id="j1", phone="+55", combined_message="", pre_extracted_intent={"amount": 10}
    )
    assert job.force_confirm is False
    assert job.attempt == 0


def test_job_id_deterministico_independe_da_ordem():
    a = derive_job_id(phone="+55", source_message_ids=["m2", "m1"], provider_message_ids=[])
    b = derive_job_id(phone="+55", source_message_ids=["m1", "m2"], provider_message_ids=[])
    assert a == b


def test_job_id_cai_nos_ids_do_provedor_sem_ids_persistidos():
    a = derive_job_id(phone="+55", source_message_ids=[], provider_message_ids=["wamid.1"])
    b = derive_job_id(phone="+55", source_message_ids=[], provider_message_ids=["wamid.1"])
    assert a == b


def test_job_id_sem_nenhuma_origem_e_unico():
    a = derive_job_id(phone="+55", source_message_ids=[], provider_message_ids=[])
    b = derive_job_id(phone="+55", source_message_ids=[], provider_message_ids=[])
    assert a != b


# ── Nomes de filas ───────────────────────────────────────────────────────────
def test_nomes_derivados_da_fila_principal():
    assert base_name("whatsapp.inbound.v1") == "whatsapp.inbound"
    assert dlq_queue("whatsapp.inbound.v1") == "whatsapp.inbound.dlq"
    assert dlq_queue("whatsapp.processing.v1") == "whatsapp.processing.dlq"
    assert retry_queue("whatsapp.inbound.v1", 4) == "whatsapp.inbound.retry.4s"
    assert dlq_routing_key("inbound") == "inbound.dlq"
    assert len(all_retry_queues("whatsapp.inbound.v1")) == 5


# ── Telefone ─────────────────────────────────────────────────────────────────
def test_normalizacao_espelha_a_da_api():
    assert normalize_phone("(41) 99999-9999") == "+5541999999999"
    assert normalize_phone("41999999999") == "+5541999999999"
    assert normalize_phone("+5541999999999") == "+5541999999999"
    assert normalize_phone("5541999999999") == "+5541999999999"
    assert normalize_phone("") == ""


def test_mascara_nunca_expoe_o_numero_completo():
    mascarado = mask_phone("+5541999999999")

    assert "999999999" not in mascarado
    assert mascarado.endswith("9999")
    assert "*" in mascarado


def test_hash_do_telefone_e_estavel_e_curto():
    assert hash_phone("(41) 99999-9999") == hash_phone("+5541999999999")
    assert len(hash_phone("+5541999999999")) == 12
