"""Consumers do pipeline WhatsApp."""

from .inbound_consumer import InboundMessageConsumer
from .processing_consumer import MessageProcessingConsumer

__all__ = ["InboundMessageConsumer", "MessageProcessingConsumer"]
