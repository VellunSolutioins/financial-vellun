# 0019 — Gasto parcelado conta no mês de cada parcela

- **Status:** Aceito
- **Data:** 2026-10-02
- **Substitui em parte:** [0018](0018-gasto-obrigacao-liquidacao.md), quanto ao mês em que o
  gasto de uma compra parcelada é reconhecido

## Contexto

A ADR 0018 passou a reconhecer a compra parcelada inteira no mês da compra
("Gastos por data da compra"): R$ 1.000 em 5x eram R$ 1.000 no mês da compra
e zero nos meses seguintes. Na prática isso não corresponde a como o usuário
vive a compra: o limite fica comprometido com os R$ 1.000, mas o que pesa no
orçamento de cada mês é a parcela de R$ 200. No dashboard, um mês com faturas a
pagar mostrava "Gastos no cartão: sem despesas", o que parecia defeito.

## Decisão

- **Gastos do mês:** a parcela conta no mês dela (`transaction_date`); todo o
  resto (avulso, recorrência, estorno) na data do fato (`event_date`). Vale para
  o resumo do dashboard, os gráficos por categoria (consolidado, por conta e por
  cartão), o comparativo mensal e o gráfico diário — um critério só,
  `spendingPeriodWhere` e `realizedSpendingFilter` em `settlement-state.ts`.
- **Realizado:** a parcela de uma compra já feita (data da compra até hoje)
  conta no mês dela, inclusive em mês futuro — é compromisso firmado, não
  previsão. Compra cadastrada com data futura e as parcelas dela são previstas.
- **Dívida e limite não mudam:** a compra inteira desde o dia dela. O
  `event_date` das parcelas continua sendo a data da compra, e é ele que o
  cartão usa para saber que a cobrança é efetiva.
- **A compra continua sendo uma entidade:** data, total e compromisso restante
  em Parcelamentos; `GET /transactions/summary?dateBasis=event` ainda dá a visão
  pela data da compra. Ela sai do dashboard: duas bases no mesmo painel
  confundiam mais do que ajudavam.
- `GET /transactions/summary` ganha `dateBasis=spending` (a regra acima), usado
  com `realizedOnly` pelos gráficos por conta e por cartão.

## Consequências

- Compra e parcelas continuam nunca somadas na mesma métrica (o que o achado 3
  da revisão protegia): o gasto é a soma das parcelas, uma por mês; a dívida, a
  compra.
- O critério de aceite "R$ 1.200 em outubro na visão de gastos por compra" da
  0018 passa a ser "R$ 400 em cada mês de parcela; dívida de R$ 1.200 desde a
  compra" (`purchases.integration.spec.ts`).
- Parcela adiantada conta no mês do adiantamento (a data dela muda para hoje).
- Bem durável comprado parcelado aparece diluído nos meses; a natureza da
  categoria (`asset_acquisition`) continua separando aquisição de consumo.

## Alternativas consideradas

- **Manter a data da compra e explicar melhor.** Rejeitada: correta, mas não é
  como o usuário acompanha o orçamento mês a mês.
- **Chave "por compra / por parcela" no dashboard.** Rejeitada por ora: duas
  bases no mesmo painel; a visão por compra fica em Parcelamentos.
- **Gravar `event_date` = data da parcela.** Rejeitada: o cartão perderia a
  informação de que a compra (e a dívida inteira) já aconteceu.
