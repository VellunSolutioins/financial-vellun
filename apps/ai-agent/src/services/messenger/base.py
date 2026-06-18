from abc import ABC, abstractmethod


class Messenger(ABC):
    """Contrato para envio de mensagens ao usuário do WhatsApp."""

    @abstractmethod
    async def send(self, phone: str, text: str) -> None:
        """Entrega ``text`` ao número ``phone``. Não deve levantar exceção
        fatal: falhas de entrega devem ser logadas, não derrubar o fluxo."""
        raise NotImplementedError
