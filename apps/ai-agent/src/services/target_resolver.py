"""Qual lançamento já existente a mensagem quer dizer ("paguei a luz").

Usado pela baixa de contas em aberto (docs/plans/018, Fase 2): a partir do
nome, da categoria e do valor ditos, ordena os itens em aberto que a API
devolveu. Funções puras, sem chamada à API.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from .reply_parsers import match_names, normalize, tokens

#: Palavras que não identificam a conta: verbos de pagar/receber, artigos,
#: "conta", datas. Sobra o assunto ("luz", "aluguel", "cliente joao").
STOPWORDS = frozenset(
    {
        "paguei", "pago", "paga", "pagar", "pagamento", "pagou", "quitei", "quitar",
        "recebi", "receber", "recebido", "recebida", "recebimento", "caiu", "entrou",
        "conta", "contas", "boleto", "fatura", "de", "da", "do", "das", "dos", "a", "o",
        "as", "os", "e", "ja", "marca", "marcar", "marque", "como", "que", "em", "no",
        "na", "nos", "nas", "meu", "minha", "hoje", "ontem", "baixa", "dar", "dei", "foi",
        "valor", "reais", "real", "r", "com", "pela", "pelo", "por", "pra", "para",
        "esse", "essa", "este", "esta", "mes", "aquela", "aquele", "ta", "eu",
    }
)
#: Diferença de valor que ainda conta como "o mesmo valor".
AMOUNT_TOLERANCE = 0.01
#: Na oferta de baixa ao criar um lançamento, o vencimento a até tantos dias.
STRONG_MATCH_DAYS = 7


def subject_tokens(*texts: str | None) -> list[str]:
    """As palavras que identificam a conta, sem as genéricas nem números."""
    seen: list[str] = []
    for text in texts:
        for word in tokens(text or ""):
            if word.isdigit() or len(word) < 3 or word in STOPWORDS or word in seen:
                continue
            seen.append(word)
    return seen


@dataclass(frozen=True)
class Ranked:
    item: dict
    score: int


def _name_score(item: dict, words: list[str], category: str | None) -> int:
    score = 0
    if category and item.get("categoryName"):
        if match_names(category, [item["categoryName"]]):
            score += 3
    description = set(tokens(item.get("description") or ""))
    category_words = set(tokens(item.get("categoryName") or ""))
    for word in words:
        if word in description or word in category_words:
            score += 2
        elif any(len(word) >= 4 and word in other for other in description):
            score += 1
    return score


def _same_amount(item: dict, amount: float | None) -> bool:
    return amount is not None and abs((item.get("remaining") or 0) - amount) < AMOUNT_TOLERANCE


def _order_key(ranked: Ranked) -> tuple:
    # Mais parecido primeiro; no empate, o vencido e depois o que vence antes.
    return (-ranked.score, not ranked.item.get("isOverdue"), ranked.item.get("dueDate") or "")


def rank_open_items(
    items: list[dict],
    *,
    words: list[str],
    category: str | None = None,
    amount: float | None = None,
) -> list[dict]:
    """Itens em aberto que combinam com o que foi dito, do mais provável ao menos.

    Sem nada dito (nem nome, nem categoria, nem valor), devolve todos, o
    vencido primeiro: "marca como pago" pergunta qual, com a lista.
    Com algo dito e nada parecido, devolve ``[]``.
    """
    if not words and not category and amount is None:
        return [r.item for r in sorted((Ranked(i, 0) for i in items), key=_order_key)]

    named = bool(words or category)
    ranked = []
    for item in items:
        score = _name_score(item, words, category)
        if named and score == 0:
            # Disse o nome e não bate: o valor igual sozinho não basta ("paguei
            # 120 de luz" não é a Internet de R$ 120).
            continue
        if _same_amount(item, amount):
            score += 2
        if score > 0:
            ranked.append(Ranked(item, score))
    ranked.sort(key=_order_key)
    if not ranked:
        return []
    # Quando um se destaca (nome **e** valor, por exemplo), só ele.
    best = ranked[0].score
    if len(ranked) > 1 and best >= ranked[1].score + 2:
        return [ranked[0].item]
    return [r.item for r in ranked]


def strong_match(
    items: list[dict],
    *,
    words: list[str],
    category: str | None,
    amount: float,
    on: date,
) -> dict | None:
    """O item em aberto que um lançamento novo provavelmente quita.

    Para oferecer "É o pagamento dela?" antes de criar um gasto duplicado:
    mesmo valor, nome parecido e vencimento perto da data do lançamento (ou já
    vencido). Só devolve se houver exatamente um assim.
    """
    found = []
    for item in items:
        if not _same_amount(item, amount) or _name_score(item, words, category) == 0:
            continue
        try:
            due = date.fromisoformat(item.get("dueDate") or "")
        except ValueError:
            continue
        close = abs((due - on).days) <= STRONG_MATCH_DAYS
        if close or (item.get("isOverdue") and on >= due):
            found.append(item)
    return found[0] if len(found) == 1 else None


def label_matches(reply: str, labels: list[str]) -> list[int]:
    """Índices das opções cujo rótulo a resposta cita ("a da luz")."""
    words = subject_tokens(reply)
    if not words:
        return match_names(reply, labels)
    hits = []
    for index, label in enumerate(labels):
        label_words = set(tokens(label))
        if any(word in label_words for word in words):
            hits.append(index)
    return hits or match_names(normalize(reply), labels)
