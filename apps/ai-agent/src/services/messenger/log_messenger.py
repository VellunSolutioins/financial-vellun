import logging

from .base import Messenger

logger = logging.getLogger(__name__)


class LogMessenger(Messenger):
    """Messenger de desenvolvimento: apenas registra a resposta em log."""

    async def send(self, phone: str, text: str) -> None:
        logger.info("[WhatsApp -> %s] %s", phone, text)
