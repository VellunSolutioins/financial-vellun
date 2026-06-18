"""Pacote de envio de mensagens ao usuário (factory log/produção)."""

from .base import Messenger
from .factory import create_messenger

# Singleton selecionado por ``WHATSAPP_PROVIDER`` (log | cloud-api).
messenger: Messenger = create_messenger()

__all__ = ["Messenger", "create_messenger", "messenger"]
