"""Corrigir e excluir lançamento pelo WhatsApp (docs/plans/018, Fase 3).

Conversas completas pelo ``process_job``, como em ``test_action_processor``:
o LLM e a API são simulados; a conversa (lista, pergunta do que mudar, "sim",
"não", 404 de quem já foi excluído) é o caminho real.
"""

from __future__ import annotations

import pytest

import src.services.message_processor as mp
from src.messaging.base import TransientError
from src.schemas.financial_intent import (
    EntryChanges,
    FinancialIntent,
    IntentType,
    TargetRef,
)
from src.services import entry_editor as module
from src.services.conversation_manager import conversation_manager
from tests.test_conversation_flows import PHONE, despesa, mundo  # noqa: F401


def lancamento(**campos) -> dict:
    base = {
        "id": "t-mercado",
        "type": "expense",
        "description": "Mercado",
        "amount": 50,
        "date": "2026-09-26",
        "categoryId": "cat-mercado",
        "categoryName": "Mercado",
        "accountId": "acc-1",
        "accountName": "Itaú",
        "onCard": False,
        "settledAmount": 50,
        "source": "whatsapp",
        "createdAt": "2026-09-26T15:00:00.000Z",
        "recurrenceType": "avulso",
        "seriesId": None,
        "installmentNumber": None,
        "installmentTotal": None,
    }
    base.update(campos)
    return base


MERCADO = lancamento()
MERCADO_ANTIGO = lancamento(
    id="t-mercado-2", amount=80, date="2026-09-20", createdAt="2026-09-20T15:00:00.000Z"
)
UBER = lancamento(
    id="t-uber-1",
    description="Uber",
    amount=20,
    date="2026-09-25",
    categoryId="cat-transporte",
    categoryName="Transporte",
    createdAt="2026-09-25T15:00:00.000Z",
)
UBER_2 = {**UBER, "id": "t-uber-2", "amount": 25, "date": "2026-09-24"}
# Feito no app, e mais novo que os do WhatsApp: "o último" não é ele.
PADARIA = lancamento(
    id="t-padaria",
    description="Padaria",
    categoryId="cat-padaria",
    categoryName="Padaria",
    source="manual",
    createdAt="2026-09-27T10:00:00.000Z",
)
TENIS = lancamento(
    id="t-tenis",
    description="Tênis",
    categoryId="cat-roupas",
    categoryName="Roupas",
    amount=100,
    accountId="card-acc",
    accountName="Nubank",
    onCard=True,
    settledAmount=0,
    recurrenceType="parcelado",
    seriesId="s-tenis",
    installmentNumber=1,
    installmentTotal=3,
)
ACADEMIA = lancamento(
    id="t-academia",
    description="Academia",
    categoryId="cat-saude",
    categoryName="Saúde",
    amount=90,
    date="2026-09-10",
    settledAmount=0,
    recurrenceType="fixo",
    seriesId="s-academia",
)


class _Resposta:
    def __init__(self, status: int, body: dict | None = None) -> None:
        self.status_code = status
        self._body = body or {}

    def json(self):
        return self._body


class Api:
    """O que o agente mandou nas rotas de correção e exclusão."""

    def __init__(self) -> None:
        self.chamadas: list[tuple[str, str, dict | None]] = []
        self.resposta: _Resposta | Exception | None = None

    def _responder(self, padrao: _Resposta):
        if isinstance(self.resposta, Exception):
            raise self.resposta
        return self.resposta or padrao

    async def patch(self, path, json):
        self.chamadas.append(("PATCH", path, json))
        corpo = {
            "amount": json.get("amount"),
            "date": json.get("transactionDate"),
            "description": json.get("description"),
        }
        return self._responder(_Resposta(200, {k: v for k, v in corpo.items() if v}))

    async def delete(self, path):
        self.chamadas.append(("DELETE", path, None))
        return self._responder(_Resposta(200, {"deleted": 3}))


@pytest.fixture
def edicao(mundo, monkeypatch):  # noqa: F811
    """Liga ``whatsapp_edit``: lançamentos recentes, catálogo e API simulados."""
    recentes = [PADARIA, MERCADO, UBER, UBER_2, MERCADO_ANTIGO, TENIS, ACADEMIA]

    async def recent(user_id):
        return mundo.recentes

    class Catalogo:
        async def accounts(self, user_id):
            return mundo.contas

        async def categories(self, user_id):
            return mundo.categorias

    api = Api()
    monkeypatch.setattr(module, "_recent", recent)
    monkeypatch.setattr(module, "user_catalog", Catalogo())
    monkeypatch.setattr(module, "api_client", api)
    mundo.recentes = [dict(r) for r in recentes]
    mundo.api = api
    return mundo


def excluir(**target) -> FinancialIntent:
    return FinancialIntent(
        intent=IntentType.cancel_last, target=TargetRef(**target), confidence=0.9
    )


def corrigir(changes: dict | None = None, **target) -> FinancialIntent:
    return FinancialIntent(
        intent=IntentType.correct_last,
        target=TargetRef(**target),
        changes=EntryChanges(**(changes or {})),
        confidence=0.9,
    )


async def pendente():
    return await conversation_manager.get(PHONE)


# ── Excluir ──────────────────────────────────────────────────────────────────
async def test_apaga_o_ultimo_feito_pelo_whatsapp_so_com_sim(edicao):
    edicao.llm["apaga o último"] = excluir(last=True)

    pergunta = await edicao.enviar("apaga o último")

    # O Padaria é mais novo, mas foi feito no app.
    assert pergunta == (
        "Excluir *Mercado — R$ 50,00 — 26/09 (Itaú)*? O valor volta para o saldo da "
        "conta Itaú.\nResponda *sim* ou *não*."
    )
    assert edicao.api.chamadas == []

    resposta = await edicao.enviar("sim")

    assert resposta == "✅ Excluí *Mercado — R$ 50,00 — 26/09 (Itaú)*."
    assert edicao.api.chamadas == [("DELETE", "/internal/users/u1/transactions/t-mercado", None)]
    assert (await pendente()).pending_action is None


async def test_nao_cancela_sem_mexer_em_nada(edicao):
    edicao.llm["apaga o último"] = excluir(last=True)

    await edicao.enviar("apaga o último")
    assert await edicao.enviar("não") == module.NOTHING_DONE
    assert edicao.api.chamadas == []
    assert (await pendente()).awaiting_confirmation is False


async def test_sem_lancamento_do_whatsapp_pede_para_dizer_qual(edicao):
    edicao.recentes = [PADARIA]
    edicao.llm["apaga o último"] = excluir(last=True)

    assert await edicao.enviar("apaga o último") == module.NO_LAST


async def test_nome_e_data_apontam_um_so(edicao):
    edicao.llm["apaga o mercado de ontem"] = excluir(description="mercado", date="2026-09-26")

    pergunta = await edicao.enviar("apaga o mercado de ontem")

    assert pergunta.startswith("Excluir *Mercado — R$ 50,00 — 26/09 (Itaú)*?")


async def test_varios_parecidos_viram_lista(edicao):
    edicao.llm["apaga o uber"] = excluir(description="uber")

    lista = await edicao.enviar("apaga o uber")

    assert lista.splitlines() == [
        "Qual destes você quer excluir?",
        "1. Uber — R$ 20,00 — 25/09 (Itaú)",
        "2. Uber — R$ 25,00 — 24/09 (Itaú)",
        "Responda com o número, ou *não* para cancelar.",
    ]
    assert (await edicao.enviar("2")).startswith("Excluir *Uber — R$ 25,00 — 24/09 (Itaú)*?")
    await edicao.enviar("sim")
    assert edicao.api.chamadas[0][1] == "/internal/users/u1/transactions/t-uber-2"


async def test_nao_encontrado_nos_ultimos_30_dias(edicao):
    edicao.llm["apaga a farmácia"] = excluir(description="farmácia")

    resposta = await edicao.enviar("apaga a farmácia")

    assert resposta == (
        "Não encontrei *farmacia* nos últimos 30 dias. Para lançamentos mais antigos, use o app."
    )


async def test_parcela_exclui_a_compra_inteira(edicao):
    edicao.llm["apaga o tênis"] = excluir(description="tênis")

    pergunta = await edicao.enviar("apaga o tênis")

    assert pergunta.startswith(
        "Isso exclui a compra inteira: *Tênis* em 3x de R$ 100,00 (Nubank), com todas as parcelas."
    )
    resposta = await edicao.enviar("sim")
    assert edicao.api.chamadas == [("DELETE", "/internal/users/u1/installments/s-tenis", None)]
    assert resposta == "✅ Excluí a compra *Tênis* (3 parcelas)."


async def test_no_fixo_exclui_so_a_ocorrencia(edicao):
    edicao.llm["apaga a academia"] = excluir(description="academia")

    pergunta = await edicao.enviar("apaga a academia")

    assert pergunta.startswith(
        "Excluir só a de 10/09 de *Academia — R$ 90,00*? As próximas continuam; para "
        "encerrar o fixo, use o app."
    )
    await edicao.enviar("sim")
    assert edicao.api.chamadas[0][1] == "/internal/users/u1/transactions/t-academia"


async def test_ja_excluido_nao_e_erro(edicao):
    edicao.llm["apaga o último"] = excluir(last=True)
    edicao.api.resposta = _Resposta(404, {"message": "Lançamento não encontrado"})

    await edicao.enviar("apaga o último")
    assert await edicao.enviar("sim") == "*Mercado* já tinha sido excluído."


async def test_recusa_da_api_chega_ao_usuario(edicao):
    edicao.llm["apaga o último"] = excluir(last=True)
    edicao.api.resposta = _Resposta(409, {"message": "A fatura deste lançamento já fechou."})

    await edicao.enviar("apaga o último")
    resposta = await edicao.enviar("sim")

    assert resposta == "Não consegui excluir: A fatura deste lançamento já fechou."
    assert (await pendente()).pending_action is None


async def test_api_fora_no_sim_mantem_a_pergunta_para_o_retry(edicao):
    edicao.llm["apaga o último"] = excluir(last=True)
    await edicao.enviar("apaga o último")
    edicao.api.resposta = ConnectionError("fora")

    with pytest.raises(TransientError):
        await edicao.enviar("sim")

    assert (await pendente()).pending_action["kind"] == module.DELETE


async def test_flag_desligada_manda_para_o_app(edicao, monkeypatch):
    async def desligada(user_id):
        raise module.FeatureDisabled

    monkeypatch.setattr(module, "_recent", desligada)
    edicao.llm["apaga o último"] = excluir(last=True)

    assert await edicao.enviar("apaga o último") == module.EDIT_UNAVAILABLE


# ── Corrigir ─────────────────────────────────────────────────────────────────
async def test_corrige_o_valor_do_ultimo_mostrando_antes_e_depois(edicao):
    edicao.llm["errei, foi 45"] = corrigir({"amount": 45}, last=True)

    pergunta = await edicao.enviar("errei, foi 45")

    assert pergunta == (
        "Corrigir *Mercado — R$ 50,00 — 26/09 (Itaú)*?\n"
        "• Valor: R$ 50,00 → R$ 45,00\n"
        "Responda *sim* ou *não*."
    )
    resposta = await edicao.enviar("sim")

    assert edicao.api.chamadas == [
        ("PATCH", "/internal/users/u1/transactions/t-mercado", {"amount": 45})
    ]
    assert resposta == "✅ Pronto! Agora está assim: *Mercado — R$ 45,00 — 26/09 (Itaú)*."


async def test_sem_dizer_o_que_muda_pergunta_e_entende_a_resposta(edicao):
    edicao.llm["corrige o mercado de ontem"] = corrigir(
        description="mercado", date="2026-09-26"
    )

    pergunta = await edicao.enviar("corrige o mercado de ontem")
    assert pergunta.startswith("O que devo mudar em *Mercado — R$ 50,00 — 26/09 (Itaú)*?")

    confirmacao = await edicao.enviar("foi 45 dia 25")

    assert "• Valor: R$ 50,00 → R$ 45,00" in confirmacao
    assert "• Data: 26/09 → 25/09" in confirmacao
    await edicao.enviar("sim")
    assert edicao.api.chamadas[0][2] == {"amount": 45, "transactionDate": "2026-09-25"}


async def test_troca_categoria_e_conta_pelo_nome(edicao):
    edicao.llm["o mercado era transporte, na carteira"] = corrigir(
        {"category_name": "Transporte", "account_name": "Carteira"}, description="mercado",
        date="2026-09-26",
    )

    pergunta = await edicao.enviar("o mercado era transporte, na carteira")

    assert "• Categoria: Mercado → Transporte" in pergunta
    assert "• Conta: Itaú → Carteira" in pergunta
    await edicao.enviar("sim")
    assert edicao.api.chamadas[0][2] == {"categoryId": "cat-transporte", "accountId": "acc-2"}


async def test_categoria_desconhecida_vira_lista(edicao):
    edicao.llm["muda a categoria do último para lazer"] = corrigir(
        {"category_name": "Lazer"}, last=True
    )

    lista = await edicao.enviar("muda a categoria do último para lazer")

    assert lista.splitlines()[0] == 'Não encontrei a categoria "Lazer". Qual destas?'
    assert "3. Outros" in lista
    confirmacao = await edicao.enviar("3")
    assert "• Categoria: Mercado → Outros" in confirmacao


async def test_compra_parcelada_se_corrige_no_app(edicao):
    edicao.llm["o tênis foi 90"] = corrigir({"amount": 90}, description="tênis")

    assert await edicao.enviar("o tênis foi 90") == module.INSTALLMENT_EDIT
    assert (await pendente()).pending_action is None


async def test_no_fixo_avisa_que_so_esta_ocorrencia_muda(edicao):
    edicao.llm["a academia foi 95"] = corrigir({"amount": 95}, description="academia")

    pergunta = await edicao.enviar("a academia foi 95")

    assert "Só esta ocorrência muda; as próximas continuam como estão." in pergunta


async def test_correcao_igual_ao_que_ja_esta_nao_pergunta(edicao):
    edicao.llm["errei, foi 50"] = corrigir({"amount": 50}, last=True)

    resposta = await edicao.enviar("errei, foi 50")

    assert resposta == "Já está assim: *Mercado — R$ 50,00 — 26/09 (Itaú)*. Não mudei nada."
    assert (await pendente()).pending_action is None


async def test_recusa_da_correcao_chega_ao_usuario(edicao):
    edicao.llm["errei, foi 45"] = corrigir({"amount": 45}, last=True)
    edicao.api.resposta = _Resposta(
        409, {"message": "Este lançamento já tem pagamento registrado."}
    )

    await edicao.enviar("errei, foi 45")
    resposta = await edicao.enviar("sim")

    assert resposta == "Não consegui corrigir: Este lançamento já tem pagamento registrado."


async def test_lancamento_novo_no_meio_da_lista_descarta_a_pergunta(edicao):
    edicao.llm["apaga o uber"] = excluir(description="uber")
    edicao.llm["gastei 30 no posto"] = despesa(
        amount=30, description="posto", category_name="Transporte"
    )

    await edicao.enviar("apaga o uber")
    resposta = await edicao.enviar("gastei 30 no posto")

    assert resposta.startswith(mp.DISCARDED_ACTION_NOTICE)
    assert "Despesa de R$ 30,00 em Transporte" in resposta
    assert edicao.api.chamadas == []


async def test_ajuda_mostra_a_secao_com_a_flag_ligada():
    ligada = mp.build_help_message({"whatsapp_edit": True})
    desligada = mp.build_help_message({})

    assert "*Corrigir e excluir*" in ligada
    assert "corrigir ou excluir um lançamento" not in ligada
    assert "*Corrigir e excluir*" not in desligada
    assert "corrigir ou excluir um lançamento" in desligada
