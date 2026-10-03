# 0015 — Pagamento de fatura e estorno

- **Status:** Aceito — substituído em parte pela [0018](0018-gasto-obrigacao-liquidacao.md) quanto a o saldo (só liquidações e transferências)
- **Data:** 2026-09-24
- **Plano:** [`plan/contas-cartoes-faturas.md`](../../plan/contas-cartoes-faturas.md), fase 4

## Contexto

Sem pagamento de fatura, quem pagava o cartão lançava uma despesa na conta
corrente — e a mesma compra passava a contar duas vezes nas despesas (no cartão
e no pagamento). Sem estorno, uma devolução virava receita, inflando receitas e
deixando a categoria da compra com a despesa cheia.

## Decisão

- **Pagamento (`card_payments`)**: cartão, fatura, conta de origem (comum e
  ativa), valor, data e `idempotencyKey` única. Gera duas pernas `transfer` com
  `transferDirection` (`out` na conta de origem, `in` no cartão) e
  `cardPaymentId`. Nunca receita nem despesa: não aparece em totais, categorias
  nem metas. Parcial, múltiplo e de contas diferentes são permitidos; acima do
  restante, o excedente vira crédito no cartão. Chave repetida devolve o mesmo
  pagamento (corrida no unique tratada como em `InternalService`).
- **Reverter** marca o pagamento `reversed` e cancela as pernas; nada é apagado.
- **Estorno (`type: refund`, `refundOfId`)**: mesma categoria da compra; a soma
  dos estornos não passa do valor da compra. No cartão, entra na fatura aberta
  na data do estorno; em conta comum, é entrada de saldo. Nas agregações,
  despesa = `expense − refund` (lançamentos, dashboards, comparativo mensal,
  metas de gasto).
- **Estorno de parcelado (`scope: series`)**: parcelas em fatura aberta/futura
  sem pagamento são canceladas; as já faturadas (fatura fechada ou paga) são
  estornadas por inteiro, na fatura aberta.
- **Saldo**: `inicial + income − expense + refund − transfer_out + transfer_in`.
  Transferência antiga, sem direção, continua fora do saldo.
- **Travas** (409, com mensagem que aponta o caminho): lançamento em fatura
  fechada ou com pagamento ativo não muda valor, data, cartão, tipo nem status
  e não é excluído — use estorno; descrição e categoria continuam editáveis.
  Perna de pagamento só muda revertendo o pagamento. Recorrência com ocorrência
  travada recusa mudança de valor, conta, dia, pausa e exclusão.

## Inconsistências encontradas e como foram resolvidas

1. **`transfer` "não é mais aceito".** O schema e o `ENTRY_TYPES` diziam que
   `transfer` existia só para registros antigos; o plano reusa o tipo nas pernas
   do pagamento. **Resolução:** `transfer` volta a ser gravado, mas **só** pelo
   pagamento de fatura e sempre com direção. A API continua recusando
   `transfer` (e `refund`) em criação e edição de lançamento; registros antigos
   sem direção seguem ignorados nos saldos.
2. **Receita em cartão.** Com estorno disponível, uma "receita" no cartão não
   tem significado: não abate fatura nem dívida e ainda inflaria as receitas.
   **Resolução:** API (manual e IA) recusa receita em conta de cartão, e o
   agente nunca resolve uma receita para um cartão. As existentes continuam
   listadas pelo `audit-cards.ts`.
3. **Compra com estorno cancelada ou excluída.** Deixaria estornos órfãos e a
   soma dos estornos acima da compra. **Resolução:** compra com estorno não é
   cancelada, excluída, nem reduzida abaixo do valor já estornado.
4. **Data do pagamento.** O plano não fala de pagamento futuro. **Resolução:** a
   data não pode ser futura — o pagamento registra o que já saiu da conta.
5. **Pagamento antecipado de fatura futura.** Uma troca de fechamento refaria a
   fatura e o pagamento ficaria apontando para uma fatura apagada.
   **Resolução:** fatura com pagamento (mesmo revertido) não é refeita nem
   podada; mantém as datas.
6. **Estorno de parcelado fora de fatura** (cartão pendente ou conta comum):
   parcela com data futura é cancelada; a de data passada é estornada.
7. **Competência do estorno.** O estorno tem a data dele: estornar em setembro
   uma compra de abril reduz a despesa da categoria em setembro, não em abril
   (o mês pode ficar negativo na categoria). Mantido — reescrever abril mudaria
   um mês já fechado.

## Consequências

- Pagar a fatura não altera despesas nem categorias; o fluxo de caixa PJ mostra
  a perna de saída como saída de caixa.
- Qualquer agregação nova de despesa deve somar `refund` com sinal negativo
  (`net-expense.ts`).
- Corrigir valor de compra em fatura fechada passa a exigir estorno — é
  intencional: a fatura fechada é o que o banco cobrou.

## Alternativas consideradas

- **Pagamento como despesa de categoria "Cartão".** Rejeitada: é a dupla
  contagem que o plano quer eliminar.
- **Estorno como receita.** Rejeitada: infla receitas e não reduz a categoria.
- **Apagar pagamento ao reverter.** Rejeitada: perde a trilha do que aconteceu.
