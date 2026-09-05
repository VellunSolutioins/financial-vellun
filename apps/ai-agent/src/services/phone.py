"""Normalizacao e mascaramento de telefone.

``normalize_phone`` espelha ``apps/api/src/common/phone.util.ts`` para que o
agente e a API cheguem exatamente ao mesmo formato canonico (E.164), que e a
chave de ``whatsapp_contacts.phone_number``.
"""

from __future__ import annotations

import hashlib
import re

_NON_DIGITS = re.compile(r"\D")


def normalize_phone(value: str) -> str:
    """Converte qualquer formato para E.164, assumindo DDI 55 quando ausente."""
    digits = _NON_DIGITS.sub("", value or "")
    if not digits:
        return ""

    # 10 digitos (DDD + fixo) ou 11 (DDD + celular): sem DDI, assume Brasil.
    if len(digits) in (10, 11):
        return f"+55{digits}"

    # 12/13 digitos comecando com 55: ja tem DDI brasileiro.
    if len(digits) in (12, 13) and digits.startswith("55"):
        return f"+{digits}"

    # Demais casos (internacional ou desconhecido): preserva os digitos.
    return f"+{digits}"


def mask_phone(value: str | None) -> str:
    """Mascara para log: ``+55419****9999``. Nunca expoe o numero completo."""
    if not value:
        return "?"
    digits = _NON_DIGITS.sub("", value)
    if len(digits) <= 6:
        return "*" * len(digits)
    return f"+{digits[:5]}{'*' * (len(digits) - 9)}{digits[-4:]}"


def hash_phone(value: str | None) -> str:
    """Hash curto e estavel, para correlacionar logs sem expor o numero."""
    if not value:
        return "?"
    return hashlib.sha256(normalize_phone(value).encode()).hexdigest()[:12]
