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
