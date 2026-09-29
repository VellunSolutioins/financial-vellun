"""Leitura de trechos de mensagem: valor, data, parcelas, frequência, sim/não."""

from __future__ import annotations

from datetime import date

import pytest

from src.schemas.financial_intent import (
    AmountBasisEnum,
    RecurrenceFrequencyEnum,
    RecurrenceTypeEnum,
    TransactionTypeEnum,
)
from src.services import reply_parsers as p

# Domingo.
HOJE = date(2026, 9, 27)


@pytest.mark.parametrize(
    ("texto", "esperado"),
    [
        ("47,50", 47.5),
        ("R$ 1.250,00", 1250.0),
        ("1.250", 1250.0),
        ("foi 30 reais", 30.0),
        ("10x de 300", 300.0),
        ("3000 em 10x", 3000.0),
        ("gastei 50 dia 10", 50.0),
        ("paguei 80 em 17/06", 80.0),
        ("12 meses", None),
        ("nada", None),
        ("0", None),
    ],
)
def test_parse_amount(texto, esperado):
    assert p.parse_amount(texto) == esperado


@pytest.mark.parametrize(
    ("texto", "esperado"),
    [
        ("hoje", HOJE),
        ("foi ontem", date(2026, 9, 26)),
        ("anteontem", date(2026, 9, 25)),
        ("17/06", date(2026, 6, 17)),
        ("17/06/2025", date(2025, 6, 17)),
        ("5/1/26", date(2026, 1, 5)),
        ("2026-06-17", date(2026, 6, 17)),
        ("dia 10", date(2026, 9, 10)),
        # O dia 30 ainda não chegou em setembro: é o de agosto.
        ("dia 30", date(2026, 8, 30)),
        # 27/09 é domingo: a sexta que passou foi 25/09.
        ("sexta passada", date(2026, 9, 25)),
        ("no domingo", date(2026, 9, 20)),
        ("31/02", None),
        ("sim", None),
    ],
)
def test_parse_date(texto, esperado):
    assert p.parse_date(texto, HOJE) == esperado


def test_dia_que_nao_existe_no_mes_anterior_vira_o_ultimo_dia():
    assert p.parse_date("dia 31", date(2026, 3, 5)) == date(2026, 2, 28)


@pytest.mark.parametrize(
    ("texto", "esperado"),
    [("10", 10), ("10x", 10), ("em 12 vezes", 12), ("dez", 10), ("duas", 2), ("sei lá", None)],
)
def test_parse_int(texto, esperado):
    assert p.parse_int(texto) == esperado


@pytest.mark.parametrize(
    ("texto", "esperado"),
    [
        ("mensal", RecurrenceFrequencyEnum.monthly),
        ("todo mês", RecurrenceFrequencyEnum.monthly),
        ("bimestral", RecurrenceFrequencyEnum.bimonthly),
        ("semestral", RecurrenceFrequencyEnum.semiannual),
        ("anual", RecurrenceFrequencyEnum.annual),
        ("semanal", None),
    ],
)
def test_parse_frequency(texto, esperado):
    assert p.parse_frequency(texto) == esperado


def test_frequencia_nao_suportada_e_reconhecida():
    assert p.mentions_unsupported_frequency("toda semana")
    assert not p.mentions_unsupported_frequency("mensal")


@pytest.mark.parametrize(
    ("texto", "frequencia", "esperado"),
    [
        ("12", RecurrenceFrequencyEnum.monthly, 12),
        ("12 meses", RecurrenceFrequencyEnum.monthly, 12),
        ("2 anos", RecurrenceFrequencyEnum.monthly, 24),
        ("um ano", RecurrenceFrequencyEnum.monthly, 12),
        ("2 anos", RecurrenceFrequencyEnum.semiannual, 4),
        ("12 meses", RecurrenceFrequencyEnum.bimonthly, 6),
        ("nao sei", RecurrenceFrequencyEnum.monthly, None),
    ],
)
def test_parse_occurrences(texto, frequencia, esperado):
    assert p.parse_occurrences(texto, frequencia) == esperado


@pytest.mark.parametrize(
    ("texto", "esperado"),
    [
        ("total", AmountBasisEnum.total),
        ("é o valor total", AmountBasisEnum.total),
        ("parcela", AmountBasisEnum.installment),
        ("de cada parcela", AmountBasisEnum.installment),
        ("hã?", None),
    ],
)
def test_parse_amount_basis(texto, esperado):
    assert p.parse_amount_basis(texto) == esperado


def test_parse_type():
    assert p.parse_type("receita") == TransactionTypeEnum.income
    assert p.parse_type("é uma despesa") == TransactionTypeEnum.expense
    assert p.parse_type("sei lá") is None


@pytest.mark.parametrize("texto", ["sim", "Sim!", "ok", "pode", "confirmo", "s"])
def test_afirmativo(texto):
    assert p.is_affirmative(texto)


@pytest.mark.parametrize("texto", ["simples", "podemos ver", "ossos"])
def test_nao_confunde_palavras_que_contem_sim_ou_pode(texto):
    assert not p.is_affirmative(texto)


@pytest.mark.parametrize("texto", ["não", "nao", "n", "cancela", "deixa pra lá", "deixa"])
def test_negativo(texto):
    assert p.is_negative(texto)


@pytest.mark.parametrize("texto", ["deixa eu ver", "nãonimo", "10"])
def test_nao_confunde_frases_com_negativa(texto):
    assert not p.is_negative(texto)


@pytest.mark.parametrize(
    ("texto", "tipo", "parcelas", "base"),
    [
        ("tv 3000 em 10x", RecurrenceTypeEnum.parcelado, 10, AmountBasisEnum.total),
        ("tv em 10x de 300", RecurrenceTypeEnum.parcelado, 10, AmountBasisEnum.installment),
        ("comprei parcelado", RecurrenceTypeEnum.parcelado, None, None),
        ("parcelei a geladeira", RecurrenceTypeEnum.parcelado, None, None),
        # Os dois formatos na mesma frase: não dá para saber qual é o valor.
        ("3000 em 10x de 300", RecurrenceTypeEnum.parcelado, 10, None),
        ("paguei 1x", RecurrenceTypeEnum.avulso, None, None),
        ("gastei 50 no mercado", RecurrenceTypeEnum.avulso, None, None),
        # Caso de produção: "gasto de" antes do valor não o torna valor da parcela.
        (
            "Adicionar gasto de 36,65 em 2x no cartão inter",
            RecurrenceTypeEnum.parcelado,
            2,
            AmountBasisEnum.total,
        ),
        (
            "Adicionar gasto 266,40 em 2x no cartão XP com roupas",
            RecurrenceTypeEnum.parcelado,
            2,
            AmountBasisEnum.total,
        ),
        ("gasto em 2x de 36,65", RecurrenceTypeEnum.parcelado, 2, AmountBasisEnum.installment),
        ("36,65 cada em 2x", RecurrenceTypeEnum.parcelado, 2, AmountBasisEnum.installment),
        (
            "tv 300 por parcela em 10x",
            RecurrenceTypeEnum.parcelado,
            10,
            AmountBasisEnum.installment,
        ),
    ],
)
def test_detect_recurrence_parcelado(texto, tipo, parcelas, base):
    hint = p.detect_recurrence(texto)
    assert (hint.recurrence_type, hint.installments, hint.amount_basis) == (tipo, parcelas, base)


def test_detect_recurrence_distingue_ambiguo_de_sem_sinal():
    assert p.detect_recurrence("3000 em 10x de 300").basis_ambiguous is True
    assert p.detect_recurrence("parcelei a geladeira").basis_ambiguous is False
    assert p.detect_recurrence("tv 3000 em 10x").basis_ambiguous is False


def test_detect_recurrence_fixo():
    hint = p.detect_recurrence("netflix 55 todo mês por 12 meses")
    assert hint.recurrence_type == RecurrenceTypeEnum.fixo
    assert hint.frequency == RecurrenceFrequencyEnum.monthly
    assert hint.occurrences == 12

    sem_prazo = p.detect_recurrence("academia 100 mensal")
    assert (sem_prazo.frequency, sem_prazo.occurrences) == (RecurrenceFrequencyEnum.monthly, None)


def test_match_names_exato_antes_de_parcial_e_sem_acento():
    nomes = ["Itaú Platinum", "Itaú", "Nubank"]
    assert p.match_names("itau", nomes) == [1]
    assert p.match_names("platinum", nomes) == [0]
    assert p.match_names("cartao nubank", nomes) == [2]
    assert p.match_names("a", nomes) == []
