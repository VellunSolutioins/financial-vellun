import logging

from ...config import settings
from .base import Messenger, MessengerConfigError
from .log_messenger import LogMessenger

logger = logging.getLogger(__name__)


def create_messenger() -> Messenger:
    """Instancia o messenger conforme ``WHATSAPP_PROVIDER`` (espelha
    ``llm/factory.py``).

    Em desenvolvimento, configuração ausente ou inválida cai para o
    ``LogMessenger``. **Em produção levanta** :class:`MessengerConfigError`: o
    fallback silencioso deixava o agente subir verde e processar tudo sem nunca
    entregar uma resposta — o default de ``WHATSAPP_PROVIDER`` é ``log``, então
    bastava esquecer a variável.
    """
    # `strip` porque um espaço sobrando no .env faria o provedor cair no ramo
    # desconhecido — funciona por acidente, mas esconde a configuração real.
    provider = (settings.whatsapp_provider or "log").strip().lower()

    if provider in ("", "log", "none"):
        if settings.is_production:
            raise MessengerConfigError(
                "WHATSAPP_PROVIDER=log em produção: nenhuma resposta seria entregue. "
                "Configure WHATSAPP_PROVIDER=cloud-api."
            )
        return LogMessenger()

    if provider in ("cloud-api", "cloud", "whatsapp"):
        try:
            from .cloud_api_messenger import WhatsappCloudApiMessenger

            return WhatsappCloudApiMessenger()
        except Exception as exc:  # noqa: BLE001
            if settings.is_production:
                raise MessengerConfigError(
                    f"WhatsappCloudApiMessenger não inicializou: {exc}"
                ) from exc
            logger.warning(
                "Não foi possível inicializar o WhatsappCloudApiMessenger; "
                "usando LogMessenger",
                exc_info=True,
            )
            return LogMessenger()

    if settings.is_production:
        raise MessengerConfigError(f"WHATSAPP_PROVIDER desconhecido: {provider}")
    logger.warning("WHATSAPP_PROVIDER desconhecido: %s; usando LogMessenger", provider)
    return LogMessenger()
