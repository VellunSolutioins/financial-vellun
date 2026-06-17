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
