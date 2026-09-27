# 0014 — Faturas de cartão: ciclo, atribuição e limite

- **Status:** Aceito
- **Data:** 2026-09-24
- **Plano:** [`plan/contas-cartoes-faturas.md`](../../plan/contas-cartoes-faturas.md), fase 3

## Contexto

"Fatura atual" era `-currentBalance` da conta interna do cartão: somava todo
o histórico, incluía parcelas de meses futuros e não sabia de fechamento,
vencimento ou pagamento. Não havia fatura como entidade.

## Decisão

- **Fatura é tabela própria** (`credit_card_invoices`), identificada por
  `(credit_card_id, reference_month)`, onde `reference_month` é o `YYYY-MM` do
  vencimento. `transactions.invoice_id` liga cada cobrança à sua fatura.
- **Ciclo em funções puras** (`invoice-cycle.ts`), em dias-calendário de
  America/Sao_Paulo: fechamento = `min(closingDay, últimoDia)`; vencimento =
  primeiro dia de vencimento depois do fechamento; a fatura com fechamento F
  cobre de F_anterior até F − 1 (compra no dia do fechamento vai para a
  seguinte).
- **Criação preguiçosa com datas gravadas.** A fatura nasce quando o primeiro
  lançamento cai no ciclo, com as datas daquele momento. Faturas gravadas
  mandam: a atribuição procura primeiro uma gravada que contenha a data; só
  fora delas usa a configuração atual, recortada para não sobrepor as gravadas.
- **Troca de fechamento/vencimento** refaz só as faturas com `periodStart`
  depois de hoje: os lançamentos delas são desligados, as faturas apagadas e a
  atribuição roda de novo com a configuração nova. A atual e as fechadas
  mantêm as datas.
- **Parcelado:** a parcela _i_ vai para o ciclo da compra + (_i_ − 1),
  encadeando "a fatura que contém o fechamento da anterior". A data da parcela
  continua sendo a competência mensal; a soma das parcelas é a de
  `installmentAmounts`.
- **`CardLedgerService.syncTransactions`** é chamado depois de toda escrita que
  cria, muda, cancela ou exclui lançamento (lançamentos, recorrências, canal de
  IA — inclusive na reentrega idempotente). É idempotente e só grava o que
  mudou. Fatura futura que fica vazia é apagada.
- **Dívida e limite** saem das faturas, nunca de `currentBalance`:
  dívida = Σ (cobranças − estornos − pagamentos) de todas as faturas, mínimo 0;
  o excedente é crédito. Limite comprometido = dívida; disponível = limite −
  comprometido. "Parcelas futuras" = cobranças em faturas que fecham depois da
  atual.
- **Configuração de cartão legado:** `POST /credit-cards/:id/setup` recebe
  fechamento, vencimento e `invoiceTrackingStart` (não futuro). Lançamentos
  anteriores ficam sem fatura ("quitados antes do controle"); os posteriores são
  atribuídos na hora.

## Inconsistências encontradas no plano e como foram resolvidas

1. **Início do controle de um cartão novo.** O plano diz
   `invoiceTrackingStart = data de criação`. Com isso, quem cadastra o cartão e
   em seguida lança as compras dos últimos dias as veria fora da fatura atual e
   do limite. **Resolução:** o controle começa no **início do ciclo aberto** no
   dia da criação. Ciclos anteriores já fecharam fora do app e ficam como
   quitados antes do controle, como no cartão legado.
2. **Identidade por mês de vencimento × troca de configuração.** Depois de uma
   troca, o ciclo de transição pode vencer no mesmo mês de uma fatura gravada,
   o que violaria a unicidade de `reference_month`. **Resolução:** o ciclo curto
   é absorvido pelo seguinte (uma fatura mais longa na transição). Compra
   retroativa que cairia antes de uma fatura gravada e colidiria com ela
   estende o início dessa fatura.
3. **Parcelas de compra anterior ao início do controle.** "Ciclo da compra +
   _i_" apontaria para ciclos anteriores ao controle. **Resolução:** nessas
   séries, cada parcela com data a partir do início do controle vai para o
   ciclo da própria data.
4. **"Fatura atual" com fatura fechada ainda a vencer.** Entre o fechamento e o
   vencimento, a fatura que o usuário precisa pagar não é a aberta.
   **Resolução:** "fatura atual" é a aberta hoje; a tela mostra à parte o
   restante das faturas fechadas (`closedUnpaid`).
5. **Comprometimento da renda.** O resumo comparava o "comprometido" com a
   renda fixa do mês; com parcelas futuras na dívida, a razão perde sentido.
   **Resolução:** a renda do mês é comparada com a soma das faturas abertas; a
   dívida total aparece separada.
6. **Cartões configurados antes desta fase** (criados na fase 1) já têm
   lançamentos sem fatura. **Resolução:** `db:backfill:invoices`, idempotente,
   atribui os lançamentos desses cartões uma vez após a migração.
7. **Receita lançada em cartão** não entra em fatura nem abate dívida: não há
   significado de "receita" em cartão. O estorno (fase 4) é o caminho.

## Consequências

- O saldo (`currentBalance`) da conta interna do cartão deixa de ter uso na
  interface; continua sendo recalculado como antes.
- Uma escrita nova de lançamento que esqueça de chamar `syncTransactions`
  deixa o lançamento fora da fatura até a próxima sincronização do cartão.
- A atribuição de um parcelado longo cria as faturas futuras de uma vez.

## Alternativas consideradas

- **Fatura calculada sob demanda, sem tabela.** Rejeitada: as datas precisam
  ser congeladas (a atual e as fechadas não podem mudar com a configuração) e o
  pagamento da fase 4 precisa de uma entidade para apontar.
- **Identidade pelo mês de fechamento.** Evitaria parte das colisões, mas o
  plano define o vencimento como referência — é o mês que o usuário reconhece.
