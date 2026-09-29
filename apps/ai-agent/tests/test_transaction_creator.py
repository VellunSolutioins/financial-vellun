"""Resolução de conta/cartão e categoria, e o lançamento enviado à API.

A API devolve contas comuns e cartões ativos na mesma lista, marcados com
``kind`` e ``isPreferred``. O que estes testes seguram:

- sem menção, vale o recurso "Padrão nos lançamentos" (conta ou cartão); sem
  ele, a conta comum mais antiga;
- nome citado que não existe vira pergunta — nunca cai em silêncio no padrão;
- categoria só do tipo do lançamento, e a resposta confirma o que foi gravado.
"""

from __future__ import annotations

from datetime import date

import pytest

from src.schemas.financial_intent import (
    AccountKindEnum,
    AmountBasisEnum,
    FinancialIntent,
    IntentType,
    RecurrenceFrequencyEnum,
    RecurrenceTypeEnum,
    TransactionTypeEnum,
)
from src.services import transaction_creator as modulo
from src.services.confirmation_rules import FIELD_ACCOUNT, FIELD_CATEGORY, Question
from src.services.transaction_creator import TransactionCreator, display_name

RECURSOS = [
    {"id": "card-acc", "name": "Nubank", "kind": "card"},
    {"id": "acc-1", "name": "Itaú", "kind": "account"},
    {"id": "acc-2", "name": "Carteira", "kind": "account"},
]
CATEGORIAS = [
    {"id": "cat-mercado", "name": "Mercado", "type": "expense"},
    {"id": "cat-outros", "name": "Outros", "type": "expense"},
    {"id": "cat-salario", "name": "Salário", "type": "income"},
]


@pytest.fixture
def catalogo(monkeypatch):
    contas: list[dict] = [dict(r) for r in RECURSOS]
    categorias: list[dict] = [dict(c) for c in CATEGORIAS]

    class FakeCatalog:
        async def accounts(self, user_id: str) -> list[dict]:
            return contas

        async def categories(self, user_id: str) -> list[dict]:
            return categorias

    monkeypatch.setattr(modulo, "user_catalog", FakeCatalog())
    return contas, categorias


def intent(**overrides) -> FinancialIntent:
    base = dict(
        intent=IntentType.create_transaction,
        transaction_type=TransactionTypeEnum.expense,
        amount=47.5,
        description="mercado",
        category_name="Mercado",
        transaction_date="2026-09-20",
        confidence=0.9,
    )
    base.update(overrides)
    return FinancialIntent(**base)


async def resolver(**overrides):
    return await TransactionCreator()._resolve_account("u1", intent(**overrides))


def pergunta(resultado) -> Question:
    assert isinstance(resultado, Question), resultado
    return resultado


# ── Conta / cartão ───────────────────────────────────────────────────────────
async def test_sem_mencao_nem_padrao_usa_a_conta_comum_mais_antiga(catalogo):
    # O cartão é o mais antigo da lista, mas não vira padrão por acaso.
    assert (await resolver(account_name=None))["id"] == "acc-1"


async def test_sem_mencao_usa_a_conta_padrao_do_usuario(catalogo):
    contas, _ = catalogo
    contas[2]["isPreferred"] = True
    assert (await resolver(account_name=None))["id"] == "acc-2"


async def test_sem_mencao_usa_o_cartao_padrao_numa_despesa(catalogo):
    contas, _ = catalogo
    contas[0]["isPreferred"] = True
    assert (await resolver(account_name=None))["id"] == "card-acc"


async def test_cartao_padrao_nao_recebe_receita(catalogo):
    contas, _ = catalogo
    contas[0]["isPreferred"] = True
    resultado = await resolver(account_name=None, transaction_type=TransactionTypeEnum.income)
    assert resultado["id"] == "acc-1"


async def test_nome_do_cartao_resolve_para_a_conta_interna_dele(catalogo):
    assert (await resolver(account_name="nubank"))["id"] == "card-acc"


async def test_nome_com_sufixo_do_prompt_tambem_casa(catalogo):
    nome = display_name(RECURSOS[0])
    assert nome == "Nubank (cartão de crédito)"
    assert (await resolver(account_name=nome))["id"] == "card-acc"


async def test_casamento_exato_vence_o_parcial(catalogo):
    contas, _ = catalogo
    contas.insert(0, {"id": "card-2", "name": "Itaú Platinum", "kind": "card"})
    assert (await resolver(account_name="Itau"))["id"] == "acc-1"


async def test_nome_desconhecido_pergunta_em_vez_de_cair_no_padrao(catalogo):
    q = pergunta(await resolver(account_name="Bradesco"))
    assert q.field == FIELD_ACCOUNT
    assert "Bradesco" in q.text
    assert "Itaú" in q.text and "Nubank (cartão)" in q.text


async def test_conta_e_cartao_com_o_mesmo_nome_sem_dizer_qual_pergunta(catalogo):
    contas, _ = catalogo
    contas.append({"id": "acc-nu", "name": "Nubank", "kind": "account"})
    q = pergunta(await resolver(account_name="Nubank"))
    assert "mais de uma opção" in q.text


async def test_conta_e_cartao_com_o_mesmo_nome_desempata_pelo_tipo(catalogo):
    contas, _ = catalogo
    contas.append({"id": "acc-nu", "name": "Nubank", "kind": "account"})
    no_cartao = await resolver(account_name="Nubank", account_kind=AccountKindEnum.card)
    na_conta = await resolver(account_name="Nubank", account_kind=AccountKindEnum.account)
    assert no_cartao["id"] == "card-acc"
    assert na_conta["id"] == "acc-nu"


async def test_no_cartao_sem_nome_usa_o_unico_cartao(catalogo):
    resultado = await resolver(account_name=None, account_kind=AccountKindEnum.card)
    assert resultado["id"] == "card-acc"


async def test_no_cartao_sem_nome_com_varios_cartoes_pergunta(catalogo):
    contas, _ = catalogo
    contas.append({"id": "card-2", "name": "Inter", "kind": "card"})
    q = pergunta(await resolver(account_name=None, account_kind=AccountKindEnum.card))
    assert q.text.startswith("Em qual cartão?")


async def test_no_cartao_sem_nome_prefere_o_cartao_padrao(catalogo):
    contas, _ = catalogo
    contas.append({"id": "card-2", "name": "Inter", "kind": "card", "isPreferred": True})
    resultado = await resolver(account_name=None, account_kind=AccountKindEnum.card)
    assert resultado["id"] == "card-2"


async def test_so_cartoes_sem_mencao_pergunta_qual(catalogo):
    contas, _ = catalogo
    contas[:] = [dict(RECURSOS[0]), {"id": "card-2", "name": "Inter", "kind": "card"}]
    assert pergunta(await resolver(account_name=None)).field == FIELD_ACCOUNT
    assert (await resolver(account_name="Nubank"))["id"] == "card-acc"


async def test_sem_nenhuma_conta_nao_resolve(catalogo):
    contas, _ = catalogo
    contas.clear()
    assert await resolver(account_name=None) is None


async def test_api_antiga_sem_kind_trata_tudo_como_conta(catalogo):
    contas, _ = catalogo
    contas[:] = [{"id": "a1", "name": "Conta"}]
    assert (await resolver(account_name=None))["id"] == "a1"
    assert display_name(contas[0]) == "Conta"


async def test_receita_citando_cartao_pergunta_a_conta(catalogo):
    q = pergunta(
        await resolver(account_name="Nubank", transaction_type=TransactionTypeEnum.income)
    )
    assert q.text.startswith("Cartão não recebe receita")
    assert "Nubank" not in q.text.split("?", 1)[1]


# ── Categoria ────────────────────────────────────────────────────────────────
async def test_categoria_de_receita_nao_serve_para_despesa(catalogo):
    q = pergunta(
        await TransactionCreator()._resolve_category("u1", intent(category_name="Salário"))
    )
    assert q.field == FIELD_CATEGORY
    assert "Salário" in q.text  # cita o nome que não encontrou
    assert "Mercado" in q.text and "Outros" in q.text


async def test_sem_categoria_pergunta_listando_as_do_tipo(catalogo):
    q = pergunta(await TransactionCreator()._resolve_category("u1", intent(category_name=None)))
    assert q.text == "Em qual categoria devo registrar esse lançamento? Mercado, Outros"


async def test_categoria_casa_sem_acento(catalogo):
    cat = await TransactionCreator()._resolve_category(
        "u1", intent(category_name="salario", transaction_type=TransactionTypeEnum.income)
    )
    assert cat["id"] == "cat-salario"


async def test_sem_catalogo_de_categorias_nao_bloqueia(catalogo):
    _, categorias = catalogo
    categorias.clear()
    assert await TransactionCreator()._resolve_category("u1", intent()) is None


async def test_pending_question_confere_conta_antes_da_categoria(catalogo):
    q = await TransactionCreator().pending_question(
        intent(account_name="Bradesco", category_name="Inexistente"), "u1"
    )
    assert q.field == FIELD_ACCOUNT
    assert await TransactionCreator().pending_question(intent(), "u1") is None


# ── Criação ──────────────────────────────────────────────────────────────────
class _Response:
    status_code = 201

    def __init__(self, body=None):
        self._body = body or {"id": "t1"}
        self.text = ""

    def json(self):
        return self._body


@pytest.fixture
def api(monkeypatch):
    enviados: list[dict] = []

    class FakeApi:
        async def post(self, path, json):
            enviados.append(json)
            return _Response()

    monkeypatch.setattr(modulo, "api_client", FakeApi())
    return enviados


async def test_cria_avulso_com_a_conta_e_categoria_resolvidas(catalogo, api):
    resultado = await TransactionCreator().create_from_intent(
        intent(category_name="mercado"), "u1", "gastei 47,50 no mercado"
    )

    assert resultado["ok"] is True
    assert api[0]["accountId"] == "acc-1"
    assert api[0]["categoryId"] == "cat-mercado"
    assert "recurrenceType" not in api[0]
    assert resultado["message"] == (
        "Lançamento criado! Despesa de R$ 47,50 em Mercado, na conta Itaú, em 20/09/2026."
    )


async def test_sem_data_usa_o_dia_em_que_a_mensagem_chegou(catalogo, api):
    await TransactionCreator().create_from_intent(
        intent(transaction_date=None), "u1", "x", reference_date=date(2026, 9, 26)
    )
    assert api[0]["transactionDate"] == "2026-09-26"


async def test_raw_input_e_a_mensagem_original_e_nao_a_ultima_resposta(catalogo, api):
    await TransactionCreator().create_from_intent(
        intent(description=None), "u1", "12", original_message="netflix 55 todo mês"
    )
    assert api[0]["rawInput"] == "netflix 55 todo mês"
    assert api[0]["description"] == "netflix 55 todo mês"


async def test_parcelado_com_valor_da_parcela_envia_o_total(catalogo, api):
    resultado = await TransactionCreator().create_from_intent(
        intent(
            amount=300,
            account_name="Nubank",
            recurrence_type=RecurrenceTypeEnum.parcelado,
            installments=10,
            amount_basis=AmountBasisEnum.installment,
        ),
        "u1",
        "tv em 10x de 300 no nubank",
    )

    assert api[0]["amount"] == 3000
    assert api[0]["recurrenceType"] == "parcelado"
    assert api[0]["installments"] == 10
    assert resultado["message"] == (
        "Lançamento criado! Despesa parcelada em 10x de R$ 300,00 (total R$ 3.000,00) "
        # No cartão, a cobrança da 1ª parcela depende da fatura: a data é da compra.
        "em Mercado, no cartão Nubank. Compra em 20/09/2026."
    )


async def test_parcelado_com_valor_total_envia_como_veio(catalogo, api):
    resultado = await TransactionCreator().create_from_intent(
        intent(
            amount=3000,
            recurrence_type=RecurrenceTypeEnum.parcelado,
            installments=10,
            amount_basis=AmountBasisEnum.total,
        ),
        "u1",
        "tv 3000 em 10x",
    )
    assert api[0]["amount"] == 3000
    # Em conta comum, a série começa na data do lançamento.
    assert "na conta" in resultado["message"]
    assert resultado["message"].endswith("1ª parcela em 20/09/2026.")


async def test_fixo_envia_frequencia_e_repeticoes(catalogo, api):
    resultado = await TransactionCreator().create_from_intent(
        intent(
            amount=55,
            category_name="Outros",
            recurrence_type=RecurrenceTypeEnum.fixo,
            recurrence_frequency=RecurrenceFrequencyEnum.monthly,
            occurrences=12,
        ),
        "u1",
        "netflix 55 todo mês por 12 meses",
    )

    assert api[0]["recurrenceType"] == "fixo"
    assert api[0]["recurrenceFrequency"] == "monthly"
    assert api[0]["recurrenceMonths"] == 12
    assert api[0]["amount"] == 55
    assert resultado["message"] == (
        "Lançamento criado! Despesa fixa mensal de R$ 55,00 em Outros, na conta Itaú, "
        "12 vezes a partir de 20/09/2026."
    )
