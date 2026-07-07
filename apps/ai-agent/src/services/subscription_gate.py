"""Verificação de direito de uso (assinatura) antes de operações pagas.

Evita gastar com LLM/STT/Vision para contas sem assinatura ativa. Consulta o
endpoint interno ``GET /internal/users/{userId}/subscription-access`` e decide o
gate. Fail-closed: se não for possível confirmar o acesso, **não** processa.
"""

import logging

from ..config import settings
from .api_client import api_client

logger = logging.getLogger(__name__)

NO_SUBSCRIPTION_MESSAGE = (
    "Sua assinatura não está ativa, então não consigo registrar lançamentos por aqui. "
    f"Para regularizar, acesse {settings.web_url}/app/conta/assinatura 💳."
)
UNAVAILABLE_MESSAGE = (
    "Estou com uma instabilidade para validar sua assinatura agora. "
    "Tente novamente em alguns instantes, por favor."
)


class SubscriptionGate:
    """Decide se um usuário pode usar o assistente (operações pagas)."""

    async def evaluate(self, user_id: str) -> tuple[bool, str | None]:
        """Retorna ``(allowed, block_message)``.

        ``block_message`` é ``None`` quando liberado; caso contrário traz a
        mensagem a enviar ao usuário (sem expor dados financeiros).
        """
        try:
            response = await api_client.get(
                f"/internal/users/{user_id}/subscription-access"
            )
        except Exception:  # noqa: BLE001 — rede instável não deve gerar custo de IA
            logger.exception("Falha ao validar assinatura do usuário %s", user_id)
            return False, UNAVAILABLE_MESSAGE

        if response.status_code != 200:
            logger.warning(
                "Resposta inesperada (%s) ao validar assinatura de %s",
                response.status_code,
                user_id,
            )
            return False, UNAVAILABLE_MESSAGE

        if response.json().get("canUseProduct"):
            return True, None
        return False, NO_SUBSCRIPTION_MESSAGE


subscription_gate = SubscriptionGate()
