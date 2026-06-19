"""Testes do adapter de entrada do webhook (formato simulado e real da Meta)."""

import json

from src.services.whatsapp_inbound import parse_inbound


def _body(payload: dict) -> bytes:
    return json.dumps(payload).encode()


def test_simulated_payload():
    result = parse_inbound(
        _body({"phone": "+5519993987410", "message": "gastei 100 no mercado", "message_id": "m1"})
    )
    assert len(result) == 1
    assert result[0].phone == "+5519993987410"
    assert result[0].message == "gastei 100 no mercado"
    assert result[0].message_id == "m1"


def test_meta_text_message():
    payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messages": [
                                {
                                    "from": "5519993987410",
                                    "id": "wamid.ABC",
                                    "timestamp": "1718900000",
                                    "type": "text",
                                    "text": {"body": "recebi 2500 de salário"},
                                }
                            ]
                        },
                    }
                ]
            }
        ],
    }
    result = parse_inbound(_body(payload))
    assert len(result) == 1
    assert result[0].phone == "5519993987410"
    assert result[0].message == "recebi 2500 de salário"
    assert result[0].message_id == "wamid.ABC"
    assert result[0].timestamp == 1718900000


def test_meta_status_event_is_ignored():
    payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "changes": [
                    {
                        "field": "messages",
                        "value": {"statuses": [{"id": "wamid.X", "status": "delivered"}]},
                    }
                ]
            }
        ],
    }
    assert parse_inbound(_body(payload)) == []


def test_meta_non_text_message_is_ignored():
    payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "messages": [
                                {"from": "5519993987410", "id": "wamid.Y", "type": "image"}
                            ]
                        }
                    }
                ]
            }
        ],
    }
    assert parse_inbound(_body(payload)) == []


def test_invalid_body_returns_empty():
    assert parse_inbound(b"not json") == []
