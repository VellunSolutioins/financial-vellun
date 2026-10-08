# 0021 — Pagamento da fatura antes do fechamento

- **Status:** Aceito
- **Data:** 2026-10-08
- **Substitui em parte:** [0015](0015-pagamentos-e-estornos.md), quanto à trava de edição
  de lançamentos em fatura com pagamento

## Contexto

Bancos deixam o cliente pagar a fatura do cartão, inteira ou em parte, antes de ela
fechar. O caso típico: adiantar parcelas e quitar tudo sem esperar o fechamento.

O pagamento em fatura aberta já era aceito pela API (`CardPaymentsService.pay` não olha
o estado da fatura), abatia a dívida e liberava o limite na hora. Faltava o resto:

- a tela oferecia "Marcar como paga" também na fatura aberta, o que parecia quitar a
  fatura e não "pagar uma parte agora";
- qualquer pagamento travava a edição e a exclusão das compras da fatura (ADR 0015).
  Com pagamento parcial antes do fechamento, as compras do mês ficavam congeladas,
  inclusive as lançadas depois do pagamento;
- a fatura que ainda não começou também aceitava pagamento, um segundo jeito de quitar
  parcelas futuras, com efeito diferente do adiantamento.

## Decisão

- **Pagar antes do fechamento é uma opção explícita** da fatura do ciclo atual: o total
  até agora ou uma parte. O valor sai da conta, abate a fatura e libera o limite na
  hora. O que passar do valor vira crédito para as faturas seguintes (`reconcileCard`).
  No fechamento, a fatura vem só com o que faltar.
- **Só o fechamento trava.** `CardLedgerService.lockReasons` deixa de considerar
  pagamento: lançamento em fatura aberta continua editável e excluível, com ou sem
  pagamento. Fatura fechada continua travada (correção só por estorno). Os valores de
  fatura são derivados: se uma compra já paga muda ou sai, a sobra do pagamento vira
  crédito.
- **Fatura que ainda não começou não recebe pagamento novo** (`periodStart` depois de
  hoje): a API recusa e a tela orienta a adiantar as parcelas, que vêm para a fatura
  aberta. Pagamentos gravados antes continuam valendo e podem ser desfeitos.

Na tela Faturas, a fatura aberta mostra o botão "Pagar", que abre a janela "Pagar antes
do fechamento" com os atalhos "Tudo até agora" e "Outro valor". A situação passa a dizer
quanto já foi pago, ou "Paga até agora" quando não falta nada. Na fatura aberta, o valor
em destaque é o que falta pagar (R$ 0,00 depois de um pagamento integral), com as
compras e o que já foi pago logo abaixo. Cada pagamento ativo aparece também como uma
linha no extrato da fatura ("Pagamento antecipado", quando feito antes do fechamento),
para a soma das linhas bater com o que falta.

### Dashboard: os gráficos por recurso seguem o dinheiro

Antes, os três gráficos de categoria contavam compras. Depois de pagar a fatura, o
dinheiro saía da conta e o gráfico das contas ("Gastos nas contas") não mostrava; as compras continuavam em
"Gastos no cartão". Agora:

| Gráfico                    | O que mostra                                                                                         | Endpoint                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Para onde foi seu dinheiro | Compras por categoria, de contas e cartões (não mudou; "Fatura do cartão" não entra)                 | `GET /dashboard/summary`           |
| Saiu da conta              | Despesas em conta + faturas pagas no mês, estas na categoria "Fatura do cartão"                      | `GET /dashboard/accounts-spending` |
| Foi no cartão              | Compras do mês no cartão ainda não pagas; fatura paga em parte tira a parte proporcional de cada uma | `GET /dashboard/cards-unpaid`      |

A proporção vem de `CardLedgerService.unpaidShareByInvoice` (restante conciliado ÷
cobrado de cada fatura), a mesma conta do "falta pagar" dos parcelamentos. Os dois
gráficos por recurso não somam o consolidado: a fatura conta no mês em que foi paga, e a
compra, no mês dela.

### Categoria do pagamento e categorias padrão novas

As duas pernas do pagamento de fatura passam a levar a categoria padrão "Fatura do
cartão" (`CARD_INVOICE_CATEGORY`). A migration `20261008120000_default_categories` cria
as categorias padrão Streaming, Delivery, Restaurante e Fatura do cartão (perfil
pessoal) e preenche a categoria nos pagamentos já gravados. Uma categoria padrão some da
lista de quem já tem uma própria com o mesmo nome e tipo (`withoutShadowedDefaults`),
no app e no WhatsApp.

## Consequências

- Estorno de compra parcelada: a parcela em fatura aberta é cancelada mesmo que a fatura
  tenha pagamento (antes era estornada). O efeito é o mesmo: o que foi pago vira crédito.
- Adiantamento: parcela de fatura futura com pagamento antigo deixa de estar travada e
  pode ser adiantada. O fluxo de adiantamento não mudou.
- Excluir uma compra já paga não devolve o dinheiro à conta: o valor fica como crédito no
  cartão. Para o dinheiro voltar, desfaz-se o pagamento.
