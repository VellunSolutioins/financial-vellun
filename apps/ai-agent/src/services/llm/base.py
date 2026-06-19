from abc import ABC, abstractmethod

from ...schemas.financial_intent import FinancialIntent


class LlmProvider(ABC):
    """Contrato para provedores de LLM que extraem intenções financeiras."""

    @abstractmethod
    async def extract_intent(self, message: str, context: dict) -> FinancialIntent:
        """Interpreta a mensagem e retorna um ``FinancialIntent`` estruturado.

        Deve levantar exceção em caso de falha, para que o chamador possa
        acionar o fallback baseado em regras.
        """
        raise NotImplementedError

    @property
    def supports_vision(self) -> bool:
        """Indica se o provider consegue extrair intenção de imagens."""
        return False

    async def extract_intent_from_image(
        self, image_bytes: bytes, mime: str, caption: str | None, context: dict
    ) -> FinancialIntent:
        """Extrai um ``FinancialIntent`` de uma imagem (ex.: comprovante).

        Providers sem suporte a visão devem manter ``supports_vision = False``.
        """
        raise NotImplementedError
