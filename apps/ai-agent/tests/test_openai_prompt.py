"""Montagem do prompt do LLM: cabeçalho com data e catálogo, e o corte por tamanho."""

from __future__ import annotations

from src.config import settings
from src.services.llm.openai_provider import OpenAiProvider

CONTEXTO = {
    "today": "2026-09-27",
    "profile_type": "individual",
    "expense_categories": ["Mercado", "Outros"],
    "income_categories": ["Salário"],
    "accounts": ["Itaú", "Nubank (cartão de crédito)"],
}


def test_cabecalho_tem_dia_da_semana_perfil_e_categorias_por_tipo():
    header = OpenAiProvider._context_header(CONTEXTO)

    assert "Data atual: 2026-09-27 (domingo)" in header
    assert "Perfil: pessoa física" in header
    assert "Categorias de despesa: Mercado, Outros" in header
    assert "Categorias de receita: Salário" in header
    assert "Contas e cartões disponíveis: Itaú, Nubank (cartão de crédito)" in header


def test_contexto_antigo_sem_tipo_ainda_lista_as_categorias():
    header = OpenAiProvider._context_header({"today": "2026-09-27", "categories": ["Mercado"]})
    assert "Categorias disponíveis: Mercado" in header


def test_historico_longo_perde_as_mensagens_antigas_e_nao_o_catalogo(monkeypatch):
    monkeypatch.setattr(settings, "conversation_context_message_limit", 50)
    historico = [
        {"direction": "inbound", "content": f"mensagem antiga {i} " + "x" * 80} for i in range(40)
    ]

    bloco = OpenAiProvider._format_history(historico, max_chars=500)

    assert len(bloco) <= 500
    assert "mensagem antiga 39" in bloco  # a mais recente fica
    assert "mensagem antiga 0 " not in bloco
