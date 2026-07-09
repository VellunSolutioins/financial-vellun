"""Mensagem de boas-vindas a novos clientes.

Disparada pela API principal (via ``POST /internal/notifications/welcome``)
logo após o cadastro. Como o cliente ainda não conhece o número de WhatsApp do
app, esta é a primeira mensagem que ele recebe — apresenta o canal e ensina,
com exemplos, como registrar lançamentos por aqui.

Reutiliza o ``messenger`` (log | cloud-api) e registra a saída como ``outbound``
via ``audit_service``, igual ao fluxo de resposta em ``message_processor``.
"""

import logging

from .audit_service import audit_service
from .messenger import messenger

logger = logging.getLogger(__name__)


def build_welcome_message(name: str | None) -> str:
    """Monta o texto de boas-vindas, personalizado pelo primeiro nome."""
    first_name = (name or "").strip().split(" ")[0] if name else ""
    greeting = f"Olá, {first_name}! 👋" if first_name else "Olá! 👋"

    return (
        f"{greeting} Seja bem-vindo(a) ao Financial Vellun.\n\n"
        "Este é o seu canal para registrar lançamentos direto pelo WhatsApp. "
        "É só me mandar uma mensagem em linguagem natural, por exemplo:\n"
        "• \"gastei 50 no mercado\"\n"
        "• \"recebi 3000 de salário\"\n"
        "• \"paguei 120 de luz ontem\"\n\n"
        "Você também pode enviar um áudio ou a foto de um comprovante que eu "
        "entendo. 📸\n\n"
        "Sempre que precisar, envie \"ajuda\". Pode me contar seu primeiro "
        "lançamento agora mesmo! 🚀"
    )


class WelcomeService:
    async def send_welcome(self, phone: str, name: str | None = None) -> str:
        """Envia a mensagem de boas-vindas e a registra como outbound.

        Não levanta exceção fatal: o ``messenger`` já trata falhas de entrega
        internamente e a auditoria é best-effort.
        """
        text = build_welcome_message(name)
        await messenger.send(phone, text)
        await audit_service.log_message(phone, "outbound", text)
        logger.info("Mensagem de boas-vindas enviada para %s", phone)
        return text


welcome_service = WelcomeService()
