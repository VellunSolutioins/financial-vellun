"""Qual item em aberto a mensagem quer dizer (Fase 2)."""

from __future__ import annotations

from datetime import date

from src.services.target_resolver import rank_open_items, strong_match, subject_tokens

LUZ = {"id": "luz", "description": "Luz", "categoryName": "Moradia", "remaining": 120,
       "dueDate": "2026-09-30", "isOverdue": False}
INTERNET = {"id": "net", "description": "Internet", "categoryName": "Moradia", "remaining": 120,
            "dueDate": "2026-09-20", "isOverdue": True}
ALUGUEL = {"id": "alu", "description": "Aluguel", "categoryName": "Moradia", "remaining": 1800,
           "dueDate": "2026-10-01", "isOverdue": False}
ITENS = [LUZ, INTERNET, ALUGUEL]


def test_assunto_sem_palavras_genericas():
    assert subject_tokens("paguei a conta de luz de 120 ontem") == ["luz"]
    assert subject_tokens("recebi do cliente João") == ["cliente", "joao"]


def test_o_nome_decide():
    assert rank_open_items(ITENS, words=["luz"]) == [LUZ]


def test_valor_igual_sozinho_nao_basta_quando_o_nome_foi_dito():
    assert rank_open_items(ITENS, words=["agua"], amount=120) == []


def test_sem_nada_dito_lista_tudo_com_o_vencido_primeiro():
    assert rank_open_items(ITENS, words=[]) == [INTERNET, LUZ, ALUGUEL]


def test_categoria_empata_e_vira_lista():
    assert {i["id"] for i in rank_open_items(ITENS, words=[], category="Moradia")} == {
        "luz", "net", "alu",
    }


def test_nome_e_valor_destacam_um_so():
    assert rank_open_items(ITENS, words=["luz"], category="Moradia", amount=120) == [LUZ]


def test_oferta_exige_valor_nome_e_data_perto():
    on = date(2026, 9, 27)
    assert strong_match(ITENS, words=["luz"], category=None, amount=120, on=on) == LUZ
    assert strong_match(ITENS, words=["luz"], category=None, amount=100, on=on) is None
    assert strong_match(ITENS, words=["luz"], category=None, amount=120,
                        on=date(2026, 12, 1)) is None
    # Vencida há mais de 7 dias, mas paga depois do vencimento: ainda é ela.
    assert strong_match(ITENS, words=["internet"], category=None, amount=120,
                        on=date(2026, 10, 15)) == INTERNET


# ── Fase 3: lançamento a corrigir ou excluir ─────────────────────────────────
from src.services.target_resolver import (  # noqa: E402
    EDIT_STOPWORDS,
    last_from_whatsapp,
    rank_recent,
)

MERCADO = {"id": "m1", "description": "Mercado", "categoryName": "Mercado", "amount": 50,
           "date": "2026-09-26", "source": "whatsapp", "createdAt": "2026-09-26T10:00:00Z"}
MERCADO_2 = {**MERCADO, "id": "m2", "amount": 80, "date": "2026-09-20",
             "createdAt": "2026-09-20T10:00:00Z"}
UBER = {"id": "u1", "description": "Uber", "categoryName": "Transporte", "amount": 20,
        "date": "2026-09-26", "source": "manual", "createdAt": "2026-09-27T10:00:00Z"}
RECENTES = [UBER, MERCADO, MERCADO_2]


def test_palavras_do_pedido_nao_contam_como_nome():
    assert subject_tokens("apaga o último lançamento", extra=EDIT_STOPWORDS) == []
    assert subject_tokens("corrige o mercado, era 45", extra=EDIT_STOPWORDS) == ["mercado"]


def test_nome_com_data_ou_valor_destaca_um():
    assert rank_recent(RECENTES, words=["mercado"]) == [MERCADO, MERCADO_2]
    assert rank_recent(RECENTES, words=["mercado"], on="2026-09-20") == [MERCADO_2]
    assert rank_recent(RECENTES, words=["mercado"], amount=50) == [MERCADO]


def test_so_valor_ou_so_data_filtram():
    assert rank_recent(RECENTES, words=[], amount=80) == [MERCADO_2]
    assert rank_recent(RECENTES, words=[], on="2026-09-26") == [UBER, MERCADO]
    assert rank_recent(RECENTES, words=[]) == []


def test_nome_que_nao_bate_nao_vale_pelo_valor():
    assert rank_recent(RECENTES, words=["farmacia"], amount=50) == []


def test_ultimo_e_o_do_whatsapp():
    assert last_from_whatsapp(RECENTES) == MERCADO
    assert last_from_whatsapp([UBER]) is None
