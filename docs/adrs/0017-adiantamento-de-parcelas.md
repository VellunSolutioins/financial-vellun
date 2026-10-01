# 0017 — Adiantamento de parcelas

- **Status:** Aceito
- **Data:** 2026-10-01

## Contexto

Banco e cartão permitem "antecipar parcelas": trazer para a fatura atual o
valor das parcelas futuras de uma compra, normalmente as últimas, às vezes com
desconto. No app, uma compra parcelada é só a série de lançamentos `parcelado`
com o mesmo `seriesId` (sem entidade própria), e a fatura de cada parcela é
calculada pelo **número** dela — parcela _n_ vai para o ciclo da compra +
(_n_ − 1) (ADR 0014) —, não pela data. Mudar a data de uma parcela não a tira
da fatura em que ela está.

## Decisão

- **A parcela adiantada continua sendo ela mesma.** Adiantar 4 parcelas de uma
  compra em 10x na 3/10 move as parcelas 10, 9, 8 e 7 para hoje; elas mantêm
  número, categoria e série, e a compra passa a terminar na 6/10. Total,
  progresso, estorno da compra e exclusão continuam funcionando sem caso novo.
- **Adianta-se sempre a cauda.** Pode ser adiantada a parcela confirmada,
  ainda não adiantada e futura: no cartão, numa fatura que começa depois de
  hoje (a aberta já é o mês atual); sem fatura (conta comum, cartão sem
  configuração, compra anterior ao controle), com data num mês seguinte ao
  atual. A busca vem da última para a primeira e para na primeira que não
  pode — uma parcela travada (fatura paga antecipadamente, estorno) corta a
  cauda.
- **Um só critério de "parcela atual".** A tela de Parcelamentos mostra em que
  parcela a compra está (`currentNumber`) pelo mesmo corte: a última que não é
  de um mês seguinte. Assim "Parcela 2/5" bate com o que aparece no mês em
  Lançamentos e com o "até 3 parcelas" do adiantamento.
- **Marca persistida, não só a data.** `transactions.advanced_at` (data do
  adiantamento), `advanced_from_date` (data prevista antes) e
  `amount_before_advance` (valor antes do desconto). No `CardLedgerService`,
  parcela com `advanced_at` sai da regra da cadeia e vai para a fatura da
  própria data — a aberta. Sem a marca, qualquer ressincronização
  (`syncCardAccount`, `rebuildFutureInvoices`) devolveria a parcela à fatura
  original.
- **Desconto opcional.** O usuário informa o total a pagar (até a soma das
  parcelas adiantadas); ele é rateado proporcionalmente em centavos, com a sobra
  na última, e cada parcela guarda o valor anterior.
- **Rota:** `POST /installments/:seriesId/advance` com
  `{ count, amount?, expectedLastNumber? }`. `expectedLastNumber` é a última
  parcela ainda não adiantada que o cliente viu: num reenvio do mesmo pedido a
  cauda já mudou, a API responde 409 e não adianta mais nada. Desconto que
  zeraria alguma parcela é recusado.
  `GET /installments` expõe `advanceable` (da última para a primeira),
  `advanceBlockedReason` e `advancedCount`.
- **Sem desfazer** nesta versão.

## Consequências

- O mês atual (lista, dashboard, fatura aberta, saldo da conta) soma as
  parcelas adiantadas; as faturas futuras que esvaziam são removidas.
- Na fatura aberta aparecem as parcelas individuais (7/10 … 10/10) com o selo
  "Adiantada", e não uma linha única como no extrato do banco.
- Editar a data de uma parcela adiantada muda a fatura dela (vale a data), ao
  contrário das demais parcelas.

## Alternativas consideradas

- **Uma linha consolidada** ("Adiantamento 7–10/10", R$ 400) no lugar das
  parcelas: fiel ao extrato do banco, mas criava um lançamento que não é
  parcela nem avulso, e estorno, exclusão e progresso do parcelamento
  precisariam tratá-lo à parte.
- **Só mudar a data das parcelas:** não muda a fatura (ver Contexto) e seria
  desfeito por qualquer ressincronização.
