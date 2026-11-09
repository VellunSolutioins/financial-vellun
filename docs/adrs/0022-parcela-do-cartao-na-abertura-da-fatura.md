# 0022 — Parcela do cartão na abertura da fatura

- **Status:** Aceito
- **Data:** 2026-10-08
- **Complementa:** [0014](0014-faturas-ciclos-e-limite.md) (a fatura de cada parcela não
  muda) e [0019](0019-gasto-parcelado-no-mes-da-parcela.md) (o mês do gasto não muda)

## Contexto

As parcelas de uma compra no cartão eram datadas na data da compra mais N meses (compra
em 29/09 → parcela 2 em 29/10). A fatura de cada parcela, porém, nunca dependeu dessa
data: a parcela N vai para a fatura da compra mais N − 1 ciclos (ADR 0014). O resultado
era uma parcela já lançada na fatura aberta com uma data que ainda não tinha chegado. Na
tela Faturas ela aparecia "no futuro", e em Lançamentos ficava em "Próximos".

No banco, a parcela é cobrada quando a fatura dela abre.

## Decisão

- **Data do lançamento:** a parcela 2 em diante, no cartão, passa a ter como
  `transaction_date` o **primeiro dia da fatura dela** (`period_start`). É o próprio dia
  do fechamento da fatura anterior: no app, a compra feita no dia do fechamento já entra
  na fatura seguinte. A parcela 1 fica na data da compra.
- **Mês do gasto:** continua sendo uma parcela por mês a partir da compra (ADR 0019). A
  data original (compra + N meses) fica em `budget_date`, e é ela que os gastos do mês,
  o comparativo mensal, o gráfico diário e as metas leem
  (`budgetDateWhere`, `spendingPeriodWhere`). `budget_date` nulo significa "vale a data
  do lançamento".
- **Quem grava:** a sincronização da fatura (`CardLedgerService.syncCard`), a mesma que
  atribui a fatura. Assim, criar a compra, trocar o fechamento do cartão ou editar a
  parcela chegam ao mesmo resultado.
- **Fatura fechada não muda:** só são datadas as parcelas em fatura aberta ou futura.
- **Parcela adiantada:** fica na data do adiantamento e pesa no mês dele, como antes
  (`budget_date` volta a nulo).
- **Editar a data de uma parcela 2+ no cartão** muda o mês em que ela pesa nos gastos; a
  data do lançamento continua sendo a abertura da fatura.

A migration `20261008130000_installment_budget_date` cria a coluna e aplica a regra às
parcelas já gravadas em faturas ainda não fechadas.

## Consequências

- Em Lançamentos, que lista pela data do lançamento, o mês em que a fatura abre pode
  mostrar duas parcelas da mesma compra (a 1ª, na data da compra, e a 2ª, na abertura da
  fatura seguinte). Os gastos do mês não mudam.
- A parcela da fatura aberta sempre tem data até hoje: aparece em "Até hoje" e na ordem
  certa do extrato da fatura.
- Em compra parcelada em conta comum nada muda: as parcelas continuam mensais a partir
  da data da compra.
