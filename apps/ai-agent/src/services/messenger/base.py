from abc import ABC, abstractmethod


class MessengerConfigError(RuntimeError):
    """Configuração que impediria qualquer entrega ao usuário.

    Em produção, isso derruba a subida do serviço: um agente que sobe verde e
    responde só no log é pior que um agente que não sobe, porque ninguém percebe.
    """


class Messenger(ABC):
    """Contrato para envio de mensagens ao usuário do WhatsApp."""

    @abstractmethod
    async def send(self, phone: str, text: str) -> None:
        """Entrega ``text`` ao número ``phone``.

        **Levanta quando a entrega não acontece** — ``TransientError`` para rede,
        5xx e rate limit; ``PermanentError`` para recusa do provedor. Engolir a
        falha fazia o job ser marcado como concluído sem o usuário receber nada.
        Quem chama decide se a falha é fatal (consumer) ou tolerável (auditoria).
        """
        raise NotImplementedError
