"""Pacote de envio de mensagens ao usuário (factory log/produção)."""

from .base import Messenger, MessengerConfigError
from .factory import create_messenger

# Singleton selecionado por ``WHATSAPP_PROVIDER`` (log | cloud-api). Criado na
# importação de propósito: em produção, configuração inválida impede a subida.
messenger: Messenger = create_messenger()

__all__ = ["Messenger", "MessengerConfigError", "create_messenger", "messenger"]
