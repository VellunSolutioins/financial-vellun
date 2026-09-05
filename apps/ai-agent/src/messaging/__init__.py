"""Camada de mensageria do agente.

Isola o broker atrás de contratos próprios (:mod:`.base` e :mod:`.contracts`),
de modo que o domínio nunca importe ``aio_pika`` diretamente. Trocar RabbitMQ
por SQS/Kafka significa adicionar um driver novo em ``messaging/`` e apontar
``MESSAGE_BROKER`` para ele.
"""

from .base import (
    ROUTE_INBOUND,
    ROUTE_PROCESSING,
    BrokerMessage,
    DeferError,
    MessageConsumer,
    MessagePublisher,
    PermanentError,
    PublishError,
    TransientError,
)
from .contracts import (
    SCHEMA_VERSION,
    DlqEnvelopeV1,
    InboundMessageV1,
    ProcessingJobV1,
    derive_job_id,
)

__all__ = [
    "ROUTE_INBOUND",
    "ROUTE_PROCESSING",
    "SCHEMA_VERSION",
    "BrokerMessage",
    "DeferError",
    "DlqEnvelopeV1",
    "InboundMessageV1",
    "MessageConsumer",
    "MessagePublisher",
    "PermanentError",
    "ProcessingJobV1",
    "PublishError",
    "TransientError",
    "derive_job_id",
]
