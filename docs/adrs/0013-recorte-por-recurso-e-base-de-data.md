# 0013 — Recorte por conta/cartão e base de data (competência × caixa)

- **Status:** Aceito — substituído em parte pela [0018](0018-gasto-obrigacao-liquidacao.md) quanto a a base de data (gastos pela data da compra, receitas recebidas)
- **Data:** 2026-09-24
- **Plano:** [`plan/contas-cartoes-faturas.md`](../../plan/contas-cartoes-faturas.md), fase 2

## Contexto

Só a listagem de lançamentos aceitava filtrar por conta, e por uma só. Os
totais do dashboard, as categorias e o comparativo mensal eram sempre
consolidados, e o "mês atual" das agregações vinha do relógio do servidor
(UTC) — entre 21h e meia-noite do último dia, o dashboard já mostrava o mês
seguinte.

## Decisão

- **Um recorte comum:** `accountIds` e `cardIds` (listas; vírgula ou parâmetro
  repetido). Nada informado = consolidado. `ResourceScope.resolve` converte o
  pedido nos `accountId` dos lançamentos (no cartão, a conta interna) e
  responde 400 se algum id não for do usuário — ou se o id de um cartão vier
  como conta. O 400 não diz qual id falhou.
- **Aplicado em:** `GET /transactions`, o novo `GET /transactions/summary`,
  `/dashboard/summary`, `/dashboard/daily`, `/dashboard/business/summary` e o
  SQL do comparativo mensal (`account_id = ANY(...)`).
- **Totais independentes da paginação:** `GET /transactions/summary` usa o mesmo
  `buildWhere` da listagem. Só lançamentos confirmados somam.
- **Base de data explícita:**
  - receitas, despesas e categorias = **competência** (data da compra ou da
    parcela), inclusive no cartão;
  - saldo = só contas comuns (cartão não tem saldo); vale também para o
    dashboard PJ, que antes somava contas de cartão;
  - fluxo de caixa PJ = só lançamentos de contas comuns.
    A interface diz isso ao lado de cada visão (`DateBasisNote`).
- **Mês corrente em America/Sao_Paulo** nas agregações sem período.
- **Web:** `ResourceFilter` com o recorte na URL (`accounts=`, `cards=`) em
  Lançamentos e nos dois dashboards; páginas `contas/[id]` e `cartoes/[id]`
  com a visão "Por período" (10 por página).

## Inconsistências encontradas e como foram resolvidas

1. **`accountId` legado × recorte novo.** A listagem já aceitava `accountId`
   (usado por Contas a pagar/receber). Mantido, e combinado com o recorte por
   `AND` — os dois filtros se somam em vez de um ignorar o outro.
2. **Status nos totais.** A listagem sem filtro de status mostra cancelados;
   somá-los nos totais estaria errado. Os totais consideram só confirmados;
   com `status=cancelled`, dão zero. Documentado no endpoint.
3. **Despesa líquida de estornos.** O plano pede despesa por categoria
   `expense − refund`, mas `refund` só existe na fase 4. Nesta fase a despesa é
   a bruta; a fase 4 troca a soma nos mesmos pontos.

## Consequências

- Toda nova agregação deve passar pelo `ResourceScope` para aceitar o recorte;
  sem isso, ela fica consolidada por omissão, não por erro.
- O comparativo mensal ganhou um fragmento SQL condicional; o parâmetro do
  recorte vem antes das bordas da janela.

## Alternativas consideradas

- **Filtrar pelo `type` da conta no front.** Rejeitada: os totais precisam ser
  do servidor para não depender da página carregada.
- **Recorte por `accountId` também para cartões.** Rejeitada: exporia o id da
  conta interna como identidade do cartão na URL e na API.
