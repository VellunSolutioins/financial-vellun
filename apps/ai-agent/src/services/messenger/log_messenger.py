import logging

from ...config import settings
from ...observability.logging import safe_phone
from .base import Messenger

logger = logging.getLogger(__name__)


class LogMessenger(Messenger):
    """Messenger de desenvolvimento: registra a resposta em log, sem enviar.

    O número nunca sai completo. O texto da resposta só aparece em ambiente
    local, onde ver o que o bot responderia é a razão de ser deste provider —
    fora dele o boot já recusa ``WHATSAPP_PROVIDER=log``, e esta guarda cobre o
    caso de alguém instanciá-lo diretamente.
    """

    async def send(self, phone: str, text: str) -> None:
        if settings.is_local:
            logger.info("[WhatsApp -> %s] %s", safe_phone(phone), text)
            return
        logger.info(
            "[WhatsApp -> %s] resposta de %d caracteres não enviada (provider log)",
            safe_phone(phone),
            len(text),
        )
