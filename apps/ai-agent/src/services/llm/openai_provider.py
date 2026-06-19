import base64
import logging
from datetime import date

from openai import AsyncOpenAI

from ...config import settings
from ...schemas.financial_intent import FinancialIntent
from .base import LlmProvider

logger = logging.getLogger(__name__)

VISION_SYSTEM_PROMPT = """Você extrai dados de COMPROVANTES de pagamento/recibos \
(imagem) em português do Brasil, preenchendo o schema FinancialIntent.

Regras:
- `intent`: use "create_transaction" quando for um comprovante financeiro legível; \
caso contrário, "unknown" com confiança baixa.
- `transaction_type`: normalmente "expense" (pagamento/compra); use "income" se o \
comprovante indicar recebimento.
- `amount`: valor total (use ponto decimal; vírgula é decimal no Brasil).
- `description`: estabelecimento/recebedor ou um resumo curto do comprovante.
- `category_name`: escolha entre as categorias disponíveis do usuário; se nada \
encaixar com clareza, deixe nulo.
- `transaction_date`: data do comprovante em ISO (YYYY-MM-DD); use a data atual \
se estiver ilegível.
- `confidence`: 0.0 a 1.0, sua confiança na leitura da imagem.
"""

SYSTEM_PROMPT = """Você é um assistente financeiro que extrai informações \
estruturadas de mensagens em linguagem natural (português do Brasil) sobre \
lançamentos financeiros pessoais ou empresariais.

Sua tarefa é preencher o schema FinancialIntent com base na mensagem do usuário.

Regras:
- `intent`: classifique a intenção. Use "create_transaction" para registrar \
gastos/receitas; "query_summary" para consultas de resumo; "correct_last"/\
"cancel_last" para corrigir/cancelar o último lançamento; "help" para pedidos \
de ajuda; "unknown" quando não souber.
- `transaction_type`: "expense" para gastos/pagamentos/compras, "income" para \
recebimentos/receitas/vendas (ex.: "venda", "vendi"), "transfer" para \
transferências.
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

Uso do histórico (quando fornecido):
- Use o "Histórico recente" apenas como contexto para interpretar a "Mensagem \
atual consolidada"; foque sempre na mensagem atual.
- Não duplique um lançamento que já foi confirmado/criado no histórico.
- Se a mensagem atual for uma correção do último lançamento, use \
"correct_last"; se for um cancelamento, use "cancel_last".
- Em respostas curtas a uma pergunta anterior (ex.: só "Nubank" ou "internet"), \
complete os campos que faltavam combinando o histórico com a mensagem atual.
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
        recent_messages = context.get("recent_messages") or []

        history_block = self._format_history(recent_messages)

        user_prompt = (
            f"Data atual: {today}\n"
            f"Categorias disponíveis: {', '.join(categories) or 'nenhuma informada'}\n"
            f"Contas disponíveis: {', '.join(accounts) or 'nenhuma informada'}\n\n"
            f"{history_block}"
            f"Mensagem atual consolidada: {message}"
        )

        # Limite de segurança no tamanho total do prompt (§13).
        max_chars = settings.conversation_context_max_chars
        if len(user_prompt) > max_chars:
            user_prompt = user_prompt[-max_chars:]

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

    @property
    def supports_vision(self) -> bool:
        return True

    async def extract_intent_from_image(
        self, image_bytes: bytes, mime: str, caption: str | None, context: dict
    ) -> FinancialIntent:
        today = context.get("today") or date.today().isoformat()
        categories = context.get("categories") or []
        accounts = context.get("accounts") or []

        b64 = base64.b64encode(image_bytes).decode()
        data_url = f"data:{mime or 'image/jpeg'};base64,{b64}"

        text_block = (
            f"Data atual: {today}\n"
            f"Categorias disponíveis: {', '.join(categories) or 'nenhuma informada'}\n"
            f"Contas disponíveis: {', '.join(accounts) or 'nenhuma informada'}\n"
            + (f"Legenda enviada pelo usuário: {caption}\n" if caption else "")
            + "Extraia o lançamento a partir do comprovante na imagem."
        )

        completion = await self._client.beta.chat.completions.parse(
            model=settings.openai_vision_model or self._model,
            messages=[
                {"role": "system", "content": VISION_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": text_block},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                },
            ],
            response_format=FinancialIntent,
        )

        parsed = completion.choices[0].message.parsed
        if parsed is None:
            raise ValueError("LLM não retornou um resultado estruturado para a imagem")
        return parsed

    @staticmethod
    def _format_history(recent_messages: list[dict]) -> str:
        """Formata o histórico recente como bloco textual para o prompt."""
        if not recent_messages:
            return ""

        # Limite de segurança no número de mensagens de contexto (§13).
        limit = settings.conversation_context_message_limit
        recent = recent_messages[-limit:]

        lines = []
        for msg in recent:
            who = "Usuário" if msg.get("direction") == "inbound" else "Assistente"
            content = (msg.get("content") or "").strip()
            if content:
                lines.append(f"- {who}: {content}")

        if not lines:
            return ""
        return "Histórico recente:\n" + "\n".join(lines) + "\n\n"
