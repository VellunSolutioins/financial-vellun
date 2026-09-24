# 0012 — Cartão de crédito como recurso próprio, separado de Contas

- **Status:** Aceito
- **Data:** 2026-09-24
- **Plano:** [`plan/contas-cartoes-faturas.md`](../../plan/contas-cartoes-faturas.md), fase 1

## Contexto

O cartão era uma `Account` (`type: credit_card`) mais um `CreditCard` 1:1,
gravados em duas escritas sem transação. A tela de Contas listava as contas
internas dos cartões e criava `credit_card` sem `CreditCard`; o `PATCH` de conta
trocava o tipo livremente. Todo seletor de conta — e o agente de IA, que caía
em `accounts[0]` quando o usuário não citava conta — enxergava a conta interna
do cartão como se fosse uma conta comum.

## Decisão

- **A conta interna continua existindo** (a infraestrutura de lançamentos é
  uma só), mas deixa de ser "conta" na experiência. Conta comum é
  `type ≠ credit_card`; o filtro é explícito (`REGULAR_ACCOUNT_WHERE`), nunca
  global. `/accounts` não lista, não cria, não altera nem desativa a conta de
  um cartão (409 apontando para `/credit-cards`).
- **Cartão é criado, alterado e arquivado em uma transação** junto da conta
  interna. `closing_day`/`due_day` ganham `CHECK 1–31` no banco.
- **Seletores usam `GET /financial-resources`** (`{ accounts, cards }`). O valor
  de um cartão no seletor é o `accountId` da conta interna, porque é para ela
  que o lançamento aponta.
- **Conta desativada e cartão arquivado não recebem lançamento novo** — na API,
  nas recorrências e no canal de IA. A conta só é revalidada quando muda, para
  que editar a descrição de uma compra antiga de um cartão arquivado continue
  possível.
- **Agente:** a lista de contas vem com `kind: account|card`; cartões aparecem
  no prompt com o sufixo "(cartão de crédito)". Sem menção, a compra vai para a
  primeira conta **comum** — nunca para um cartão por acaso.
- **Cartões legados ficam em configuração pendente** (`closingDay`, `dueDay` ou
  `invoiceTrackingStart` nulos). Nenhuma data é inventada.

## Inconsistências encontradas no plano e como foram resolvidas

1. **Órfãs de pessoa jurídica.** O plano manda criar um `CreditCard` para toda
   conta `credit_card` órfã, mas também decide que Cartões existem só no perfil
   PF. Uma órfã de PJ viraria um cartão que o usuário não tem tela para ver.
   **Resolução:** na migração, órfãs de PJ passam a `type = other` e continuam
   em Contas; só as de PF viram cartão pendente. `POST /credit-cards` responde
   403 para PJ. O `audit-cards.ts` lista as órfãs antes da migração.
2. **Dia de vencimento 1–28 × 1–31.** O DTO antigo limitava `dueDay` a 28; o
   plano define 1–31 com clamp no mês curto. Vale o plano; o `CHECK` do banco
   segue 1–31.
3. **Configuração de cartão pendente antes da fase 3.** O `POST
/credit-cards/:id/setup` (que escolhe `invoiceTrackingStart` e atribui
   faturas) só existe na fase 3. Para não criar cartões "configurados" sem
   início de controle, o `PATCH` recusa (409) mudar fechamento/vencimento de um
   cartão pendente; a tela explica que as datas vêm da configuração.
4. **Usuário só com cartões e sem conta comum.** O fallback do agente deixa de
   existir nesse caso: sem conta comum e sem cartão citado, a mensagem pede para
   cadastrar uma conta ou dizer o cartão, em vez de lançar no cartão.

## Consequências

- Uma conta `credit_card` sem `CreditCard` deixa de ser um estado alcançável
  pela API. A migração corrige as existentes; o teste de integração reexecuta o
  trecho de backfill da migração sobre dados legados.
- "Fatura atual" ainda é `-currentBalance` nesta fase; a fase 3 troca pelo
  cálculo por fatura.
- Lançamentos continuam apontando para `accountId`. Nada nos dados de
  lançamento muda.

## Alternativas consideradas

- **Filtro global de Prisma para esconder contas de cartão.** Rejeitada: toda
  consulta que precisa da conta interna (saldo, lançamentos, agente) teria de
  desligar o filtro, e a regra ficaria invisível.
- **Converter órfãs de PJ em cartão também.** Rejeitada: criaria dados que o
  perfil não consegue gerenciar.
