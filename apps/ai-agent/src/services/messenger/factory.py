import logging

from ...config import settings
from .base import Messenger
from .log_messenger import LogMessenger

logger = logging.getLogger(__name__)


def create_messenger() -> Messenger:
    """Instancia o messenger conforme ``WHATSAPP_PROVIDER`` (espelha
    ``llm/factory.py``). Em caso de falha de configuração do provedor real,
    cai para o ``LogMessenger`` para não impedir a subida do serviço."""
    # `strip` porque um espaço sobrando no .env faria o provedor cair no ramo
    # desconhecido — funciona por acidente, mas esconde a configuração real.
    provider = (settings.whatsapp_provider or "log").strip().lower()

    if provider in ("", "log", "none"):
        return LogMessenger()

    if provider in ("cloud-api", "cloud", "whatsapp"):
        try:
            from .cloud_api_messenger import WhatsappCloudApiMessenger

            return WhatsappCloudApiMessenger()
        except Exception:  # noqa: BLE001
            logger.warning(
                "Não foi possível inicializar o WhatsappCloudApiMessenger; "
                "usando LogMessenger",
                exc_info=True,
            )
            return LogMessenger()

    logger.warning("WHATSAPP_PROVIDER desconhecido: %s; usando LogMessenger", provider)
    return LogMessenger()
