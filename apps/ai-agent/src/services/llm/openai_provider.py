import logging
from datetime import date

from openai import AsyncOpenAI

from ...config import settings
from ...schemas.financial_intent import FinancialIntent
from .base import LlmProvider

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """Você é um assistente financeiro que extrai informações \
estruturadas de mensagens em linguagem natural (português do Brasil) sobre \
lançamentos financeiros pessoais ou empresariais.

Sua tarefa é preencher o schema FinancialIntent com base na mensagem do usuário.

Regras:
- `intent`: classifique a intenção. Use "create_transaction" para registrar \
gastos/receitas; "query_summary" para consultas de resumo; "correct_last"/\
"cancel_last" para corrigir/cancelar o último lançamento; "help" para pedidos \
de ajuda; "unknown" quando não souber.
- `transaction_type`: "expense" para gastos/pagamentos, "income" para \
recebimentos/receitas, "transfer" para transferências.
- `amount`: valor numérico (use ponto decimal). Interprete vírgula como \
separador decimal brasileiro (ex.: "47,50" -> 47.5).
- `description`: descrição curta do lançamento.
- `category_name`: escolha a categoria mais provável dentre as disponíveis do \
usuário. Se nenhuma se encaixar com clareza, deixe nulo.
- `account_name`: conta mencionada, se houver.
- `transaction_date`: data em formato ISO (YYYY-MM-DD). Resolva datas \
relativas ("hoje", "ontem") usando a data atual fornecida.
- `confidence`: 0.0 a 1.0, sua confiança na extração.
- `needs_confirmation`: true quando faltar valor, tipo, ou houver ambiguidade.
- `confirmation_question`: pergunta a fazer ao usuário quando \
needs_confirmation for true.
"""


class OpenAiProvider(LlmProvider):
    def __init__(self) -> None:
        if not settings.openai_api_key:
            raise ValueError("OPENAI_API_KEY não configurada")
        self._client = AsyncOpenAI(api_key=settings.openai_api_key)
        self._model = settings.openai_model

    async def extract_intent(self, message: str, context: dict) -> FinancialIntent:
        today = context.get("today") or date.today().isoformat()
        categories = context.get("categories") or []
        accounts = context.get("accounts") or []

        user_prompt = (
            f"Data atual: {today}\n"
            f"Categorias disponíveis: {', '.join(categories) or 'nenhuma informada'}\n"
            f"Contas disponíveis: {', '.join(accounts) or 'nenhuma informada'}\n\n"
            f"Mensagem do usuário: {message}"
        )

        completion = await self._client.beta.chat.completions.parse(
            model=self._model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format=FinancialIntent,
        )

        parsed = completion.choices[0].message.parsed
        if parsed is None:
            raise ValueError("LLM não retornou um resultado estruturado")
        return parsed
