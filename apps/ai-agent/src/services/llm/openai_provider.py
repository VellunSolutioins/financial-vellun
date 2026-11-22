import base64
import logging

from openai import AsyncOpenAI

from datetime import date

from ...config import settings
from ...schemas.financial_intent import FinancialIntent
from ..clock import today_local, weekday_pt
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
- `category_name`: escolha entre as categorias disponíveis do usuário, do grupo \
compatível com o tipo (despesa ou receita); se nada encaixar com clareza, deixe nulo.
- `account_name` / `account_kind`: se o comprovante ou a legenda indicar o cartão \
ou a conta usados, o nome exatamente como aparece em "Contas e cartões \
disponíveis" e `account_kind` ("card" para cartão de crédito); senão, nulos.
- `transaction_date`: data do comprovante em ISO (YYYY-MM-DD); use a data atual \
se estiver ilegível.
- `recurrence_type`: "parcelado" se o comprovante mostrar parcelamento (ex.: \
"3x", "parcela 1/3"), com `installments` e `amount_basis` ("total" se o valor \
lido for o total da compra, "installment" se for o de uma parcela); senão "avulso".
- `confidence`: 0.0 a 1.0, sua confiança na leitura da imagem.
"""

SYSTEM_PROMPT = """Você é um assistente financeiro que extrai informações \
estruturadas de mensagens em linguagem natural (português do Brasil) sobre \
lançamentos financeiros pessoais ou empresariais.

Sua tarefa é preencher o schema FinancialIntent com base na mensagem do usuário.

Regras:
- `intent`: classifique a intenção. Use "create_transaction" para registrar \
gastos/receitas, inclusive contas a pagar ou a receber ("conta de internet de \
100 vence dia 20", "boleto de 300 vence sexta"); "query_summary" só para \
**perguntas** sobre os próprios números, sem valor a registrar ("quanto gastei \
com mercado?", "qual meu saldo?", "o que tenho pra pagar?"). Mensagem com um \
valor a registrar nunca é "query_summary"; pergunta sem valor nunca é \
"create_transaction"; "settle_bill" para dar baixa em algo que **já estava \
lançado em aberto**, quando a mensagem diz isso ("marca a luz como paga", "já \
paguei o aluguel", "dar baixa na internet", "recebi do cliente João, que estava \
pendente") — `transaction_type` "expense" para pagamento e "income" para \
recebimento, `description` com o nome da conta, `amount` só se o valor pago for \
dito; um gasto novo com valor ("paguei 120 de luz") continua \
"create_transaction"; "pay_invoice" para o pagamento da fatura do cartão de \
crédito ("paguei a fatura do Nubank", "paguei 500 da fatura") — nunca é \
"create_transaction" nem gasto no cartão; \
"correct_last" \
para corrigir um lançamento já registrado ("errei, foi 45", "corrige o mercado \
de ontem, era 45", "muda a categoria do uber para Transporte") e "cancel_last" \
para excluir um ("apaga o último", "exclui o mercado de ontem", "cancela o \
lançamento de 50"); "help" para pedidos de ajuda; "unsupported_movement" \
para dinheiro que só muda de lugar entre \
contas do próprio usuário — transferência entre as contas dele, empréstimo \
recebido ou pagamento do principal de um empréstimo/financiamento, aporte ou \
resgate de investimento (isso não é receita nem despesa); "unknown" quando \
não souber.
- `transaction_type`: "expense" para gastos/pagamentos/compras, "income" para \
recebimentos/receitas/vendas (ex.: "venda", "vendi"). Pix ou transferência \
para outra pessoa ou empresa é "expense"; recebido de outra pessoa é \
"income". Rendimento de investimento é "income"; juros pagos, "expense".
- `amount`: valor numérico (use ponto decimal). Interprete vírgula como \
separador decimal brasileiro (ex.: "47,50" -> 47.5).
- `description`: descrição curta do lançamento.
- `category_name`: escolha a categoria mais provável dentre as disponíveis do \
usuário, **só do grupo do tipo do lançamento** ("Categorias de despesa" para \
expense, "Categorias de receita" para income), com o nome exatamente como \
aparece. Se nenhuma se encaixar com clareza, deixe nulo. Não use "Outros" como \
padrão: só quando o usuário disser "outros" (sem categoria clara, deixe nulo \
para o sistema perguntar).
- `account_name`: conta ou cartão mencionado, com o nome exatamente como \
aparece em "Contas e cartões disponíveis", **incluindo** o sufixo "(cartão de \
crédito)" quando for o cartão. Se existir uma conta e um cartão com o mesmo \
nome, use o cartão só quando o usuário indicar cartão/crédito. Sem menção a \
conta ou cartão, deixe nulo (o sistema usa a conta padrão do usuário).
- `account_kind`: "card" quando o usuário indicar que pagou no cartão de \
crédito ("no cartão", "no crédito"), mesmo sem dizer qual; "account" quando \
indicar conta, débito, Pix ou dinheiro; nulo sem indicação. "Gastei", \
"paguei", "comprei" e "compra" não indicam conta nem cartão: sem menção \
explícita, `account_name` e `account_kind` ficam nulos (o padrão do usuário \
pode ser um cartão).
- `transaction_date`: data em formato ISO (YYYY-MM-DD), resolvida a partir da \
"Data atual" fornecida: "hoje", "ontem", "anteontem"; "dia 10" é o dia 10 do \
mês atual, ou do mês anterior se o dia 10 ainda não chegou (exceto em conta a \
pagar ou lançamento que ainda vai acontecer); "sexta", "sexta passada" é a \
última sexta que já passou; "17/06" sem ano é do ano atual. Sem data na \
mensagem, use a data atual.
- `recurrence_type`: "avulso" (padrão, uma única vez); "parcelado" para compra \
parcelada ("parcelado", "parcelei", "em 10x", "em 10 vezes", "10 parcelas"); \
"fixo" para lançamento que se repete ("todo mês", "mensal", "mensalidade", \
"assinatura", "recorrente", "fixo", "anual"). "1x" ou "à vista" é "avulso". \
Parcelado só existe para despesa: nunca use "parcelado" numa receita.
- `installments`: no parcelado, o número de parcelas, se informado; senão nulo.
- `amount_basis`: no parcelado, "installment" se `amount` for o valor de cada \
parcela, "total" se for o valor da compra inteira. Decide o que liga o valor \
às parcelas, não o que vem antes dele: "Nx de V" é parcela; "V em Nx" é total, \
mesmo com "gasto de", "compra de" ou "paguei" antes do valor. Exemplos: \
"3000 em 10x" -> total; "gasto de 36,65 em 2x" -> total; "compra de 120 \
parcelada em 3" -> total; "10x de 300" -> installment; "em 2x de 36,65" -> \
installment; "36,65 cada, em 2x" -> installment. Nulo se não der para saber \
(ex.: "3000 em 10x de 300"). Não multiplique nem divida o valor: `amount` é \
sempre o número que o usuário escreveu.
- `recurrence_frequency`: no fixo, "monthly" (mensal), "bimonthly" (bimestral), \
"semiannual" (semestral) ou "annual" (anual), se informada; nulo se não for \
informada ou for outra (semanal, diária).
- `occurrences`: no fixo, quantas vezes o lançamento se repete ("por 12 meses" \
no mensal = 12; "por 2 anos" no mensal = 24), se informado; senão nulo.
- `card_name`: só no "pay_invoice", o cartão da fatura, com o nome exatamente \
como aparece em "Contas e cartões disponíveis", sem o sufixo "(cartão de \
crédito)"; nulo se não for citado. No "pay_invoice", `account_name` é a conta \
de onde saiu o dinheiro, se dita ("paguei a fatura pelo Itaú"), e `amount` o \
valor pago, se dito.
- `summary_focus`: só no "query_summary": "spending" (quanto gastou), \
"income" (quanto recebeu), "balance" (saldo), "upcoming" (o que tem a pagar \
ou o que vence) ou "overview" (resumo geral); nulo nas outras intenções.
- `period_start`/`period_end`: só no "query_summary", o período perguntado em \
ISO (YYYY-MM-DD), a partir da "Data atual": "esse mês" é do dia 1 ao último \
dia do mês atual; "mês passado", o mês anterior inteiro; "outubro", outubro \
inteiro (do ano atual, ou do anterior se outubro ainda não chegou); "essa \
semana", de segunda a domingo; "hoje", só hoje. Sem período na pergunta, \
deixe os dois nulos. Numa consulta sobre uma categoria ("quanto gastei com \
mercado?"), preencha `category_name` com a categoria de despesa do usuário.
- `target`: só no "correct_last" e no "cancel_last", qual lançamento já \
registrado a mensagem aponta: `last` true só para "o último" ou quando \
nenhum lançamento é citado ("errei, foi 45"), false quando um nome é citado; \
`description` com o nome citado ("mercado", "uber"); `amount` e `date` (ISO) \
só se a mensagem disser o valor ou a data **atuais** do lançamento ("o \
mercado de 50 de ontem") — sem data na mensagem, `date` fica nulo (não use a \
data atual). Nas outras intenções, nulo.
- `changes`: só no "correct_last", o que muda, com o valor **novo**: `amount` \
("foi 45", "era 45"), `transaction_date` (ISO, "era ontem", "foi dia 10"), \
`category_name` (categoria do usuário, nome exato), `account_name` (conta ou \
cartão citado, nome exato; nulo se não citado) e `description` (nome novo, só \
se pedido). O que não muda fica nulo: sem data nova na mensagem, \
`transaction_date` fica nulo. Em "corrige o mercado de ontem, foi 45", \
"ontem" é do `target` e 45 é do `changes`; em "o mercado foi dia 20" ou \
"errei, era ontem", a data é do `changes`. Nas outras intenções, nulo.
- `confidence`: 0.0 a 1.0, sua confiança na extração.
- `needs_confirmation`: true quando faltar valor, tipo, ou houver ambiguidade.
- `confirmation_question`: pergunta a fazer ao usuário quando \
needs_confirmation for true.

Uso do histórico (quando fornecido):
- Use o "Histórico recente" apenas como contexto para interpretar a "Mensagem \
atual consolidada"; foque sempre na mensagem atual.
- Se a mensagem atual tiver valor e linguagem de novo gasto/receita, trate como \
um novo lançamento independente, mesmo que seja parecida com mensagens anteriores.
- Não use "correct_last" ou "cancel_last" por semelhança com o histórico; use \
essas intenções somente quando a mensagem atual pedir explicitamente correção, \
alteração, cancelamento, remoção ou desfazer.
- Não duplique um lançamento que já foi confirmado/criado no histórico apenas \
quando a mensagem atual não trouxer uma nova solicitação de registro.
- Se a mensagem atual for uma correção do último lançamento, use \
"correct_last"; se for um cancelamento, use "cancel_last".
- Em respostas curtas a uma pergunta anterior (ex.: só "Nubank" ou "internet"), \
complete os campos que faltavam combinando o histórico com a mensagem atual.
"""


class OpenAiProvider(LlmProvider):
    def __init__(self) -> None:
        if not settings.openai_api_key:
            raise ValueError("OPENAI_API_KEY não configurada")
        # Sem estes dois, o SDK espera 600s e tenta 2 vezes — até dez minutos
        # segurando um slot de concorrência do processamento, e o lock do
        # telefone com ele. Ver `OPENAI_TIMEOUT_SECONDS` na configuração.
        self._client = AsyncOpenAI(
            api_key=settings.openai_api_key,
            timeout=settings.openai_timeout_seconds,
            max_retries=settings.openai_max_retries,
        )
        self._model = settings.openai_model

    async def extract_intent(self, message: str, context: dict) -> FinancialIntent:
        recent_messages = context.get("recent_messages") or []
        header = self._context_header(context)
        current = f"Mensagem atual consolidada: {message}"

        # Limite de segurança no tamanho total do prompt (§13). Só o histórico
        # encolhe: cortar pelo começo levava justamente a data e o catálogo.
        budget = settings.conversation_context_max_chars - len(header) - len(current)
        history_block = self._format_history(recent_messages, max_chars=max(budget, 0))

        user_prompt = f"{header}{history_block}{current}"

        completion = await self._client.beta.chat.completions.parse(
            model=self._model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format=FinancialIntent,
            temperature=settings.openai_temperature,
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
        b64 = base64.b64encode(image_bytes).decode()
        data_url = f"data:{mime or 'image/jpeg'};base64,{b64}"

        text_block = (
            self._context_header(context)
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
            temperature=settings.openai_temperature,
        )

        parsed = completion.choices[0].message.parsed
        if parsed is None:
            raise ValueError("LLM não retornou um resultado estruturado para a imagem")
        return parsed

    @staticmethod
    def _context_header(context: dict) -> str:
        """Data, perfil e catálogo do usuário: o que o LLM precisa para resolver
        datas relativas, categoria e conta."""
        today_iso = context.get("today") or today_local().isoformat()
        try:
            today = f"{today_iso} ({weekday_pt(date.fromisoformat(today_iso))})"
        except ValueError:
            today = today_iso

        def joined(items: list[str] | None) -> str:
            return ", ".join(items or []) or "nenhuma informada"

        profile = {"individual": "pessoa física", "business": "pessoa jurídica"}.get(
            context.get("profile_type") or ""
        )
        lines = [f"Data atual: {today}"]
        if profile:
            lines.append(f"Perfil: {profile}")
        if "expense_categories" in context or "income_categories" in context:
            lines.append(f"Categorias de despesa: {joined(context.get('expense_categories'))}")
            lines.append(f"Categorias de receita: {joined(context.get('income_categories'))}")
        else:
            lines.append(f"Categorias disponíveis: {joined(context.get('categories'))}")
        lines.append(f"Contas e cartões disponíveis: {joined(context.get('accounts'))}")
        return "\n".join(lines) + "\n\n"

    @staticmethod
    def _format_history(recent_messages: list[dict], max_chars: int | None = None) -> str:
        """Formata o histórico recente como bloco textual para o prompt.

        Com ``max_chars``, descarta as mensagens mais antigas até caber.
        """
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

        def render(kept: list[str]) -> str:
            return "Histórico recente:\n" + "\n".join(kept) + "\n\n" if kept else ""

        while lines and max_chars is not None and len(render(lines)) > max_chars:
            lines.pop(0)
        return render(lines)
