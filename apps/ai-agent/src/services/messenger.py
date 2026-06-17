"""Envio de mensagens ao usuário.

No MVP apenas registra em log (integração real com provedor é fora de escopo).
A resposta também é devolvida no corpo HTTP do webhook para facilitar testes.
"""

import logging

logger = logging.getLogger(__name__)


class Messenger:
    async def send(self, phone: str, text: str) -> None:
        logger.info("[WhatsApp -> %s] %s", phone, text)


messenger = Messenger()
