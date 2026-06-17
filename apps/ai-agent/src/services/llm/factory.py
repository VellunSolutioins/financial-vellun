import logging

from ...config import settings
from .base import LlmProvider

logger = logging.getLogger(__name__)


def create_llm_provider() -> LlmProvider | None:
    """Instancia o provider de LLM conforme ``LLM_PROVIDER``.

    Retorna ``None`` quando nenhum LLM está disponível/configurado, sinalizando
    ao ``IntentClassifier`` que deve usar apenas regras.
    """
    provider = (settings.llm_provider or "").lower()

    if provider in ("", "rules", "none"):
        return None

    if provider == "openai":
        if not settings.openai_api_key:
            logger.info("OPENAI_API_KEY não configurada; usando fallback de regras")
            return None

        try:
            from .openai_provider import OpenAiProvider

            return OpenAiProvider()
        except Exception:  # noqa: BLE001
            logger.warning(
                "Não foi possível inicializar o OpenAiProvider; usando fallback de regras",
                exc_info=True,
            )
            return None

    logger.warning("LLM_PROVIDER desconhecido: %s; usando fallback de regras", provider)
    return None
