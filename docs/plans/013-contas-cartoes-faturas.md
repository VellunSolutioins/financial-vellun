# Contas, Cartões e Faturas — plano de implementação

## Contexto

Hoje o cartão é uma `Account` (`type: credit_card`) + `CreditCard` (1:1 por `accountId`), criadas em duas escritas sem transação (`credit-cards.service.ts` `create` L165). A tela de Contas lista as contas internas dos cartões e permite criar `credit_card` sem `CreditCard` (`contas/page.tsx` L27/L193; DTO `create-account.dto.ts` aceita qualquer `AccountType`; `update` troca tipo livremente). "Fatura atual" = `-account.currentBalance` (`toCardView` L93). Não há fechamento, faturas, pagamento de fatura, estorno, nem filtro por conta nas agregações (só `findAll` aceita um `accountId`). Todo seletor de conta (TransactionForm, RecurrenceForm, PendingTransactionsView) e o agente de IA (`transaction_creator.py` `_resolve_account`, fallback `accounts[0]`) enxergam as contas internas dos cartões.

Objetivo: separar Contas e Cartões na experiência, mantendo a `Account` interna por cartão e a infraestrutura única de lançamentos; faturas como domínio próprio; visões por conta, por cartão, por conjunto e consolidada.

**Decisões do usuário:** compra no dia do fechamento vai para a **próxima** fatura · cartões legados ficam em **configuração pendente** (sem inventar datas; o usuário escolhe a partir de quando os lançamentos contam como dívida) · Cartões **só no perfil PF** (filtros por conta valem para PF e PJ) · entrega **em 4 fases, um commit cada**, validadas antes da próxima.

## Decisões de domínio

- **Ciclo da fatura** (funções puras em `apps/api/src/credit-cards/invoice-cycle.ts`, datas-calendário em America/Sao_Paulo como no resto do projeto — `todaySaoPaulo`, `parseDateOnly`, `@db.Date`):
  - `closingDate(M) = min(closingDay, últimoDia(M))`; `dueDate` = primeira data com dia `min(dueDay, últimoDia)` **depois** do fechamento.
  - A fatura com fechamento `F` cobre compras de `F_anterior` até `F − 1 dia` (compra no dia do fechamento → próxima).
  - Identidade da fatura = `referenceMonth` (`YYYY-MM` do vencimento). `closingDay`/`dueDay` 1–31, com clamp nos meses curtos.
  - Estado do ciclo derivado: `open` se hoje < `closingDate`, senão `closed`. Situação de pagamento derivada dos valores: `unpaid` / `partial` / `paid` / `credit` (pago acima).
  - Datas gravadas na fatura ao criá-la (criação preguiçosa quando um lançamento cai no ciclo). Mudar fechamento/vencimento recalcula só faturas **futuras** (`periodStart > hoje`); a atual e as fechadas mantêm datas.
- **Atribuição**: `Transaction.invoiceId` explícito. Compra à vista → ciclo da data. Parcelada no cartão → parcela *i* vai para o ciclo da compra + *i* (sem depender de clamp de data); `transactionDate` da parcela continua sendo a competência mensal atual. Soma das parcelas = total (reusa `installmentAmounts`). A compra não existe como linha "integral": só as parcelas, ligadas por `seriesId`.
- **Legado / configuração pendente**: `CreditCard.closingDay`, `dueDay` anuláveis; `invoiceTrackingStart` (data). Sem fechamento → cartão "configurar fechamento": lançamentos ficam sem fatura, visíveis no período. Ao configurar, o usuário escolhe `invoiceTrackingStart`: lançamentos anteriores ficam "quitados antes do controle" (fora de dívida/limite, visíveis no histórico); os posteriores são atribuídos às faturas. Cartões novos: `invoiceTrackingStart` = data de criação.
- **Dívida e limite** (por cartão, desde `invoiceTrackingStart`): `dívida total = Σ compras confirmadas (inclui parcelas futuras) − Σ estornos − Σ pagamentos ativos`, mínimo 0; excedente vira `crédito no cartão`. `limite comprometido = dívida total`; `disponível = limite − comprometido`. `parcelas futuras` = cobranças em faturas com fechamento posterior ao da fatura atual. Pagamento e estorno liberam limite. Nada disso usa `currentBalance`.
- **Pagamento** (`CardPayment`): cartão, fatura, conta de origem, valor, data, `idempotencyKey` único. Gera duas pernas `type: transfer` com `transferDirection` (`out` na conta de origem, `in` no cartão) e `cardPaymentId`; nunca `income`/`expense` → não entra em receitas, despesas nem categorias. Parcial, múltiplo e de contas diferentes permitidos; acima do restante vira crédito. Reverter = pagamento `reversed` + pernas `cancelled` (histórico preservado). `CreditCard.paymentAccountId` = conta preferida (só sugestão).
- **Estorno** (`type: refund`, `refundOfId`): mesma categoria da compra; no cartão, cai na fatura aberta da data do estorno; soma dos estornos ≤ valor original. Relatórios de despesa por categoria = `expense − refund`. Em conta comum, estorno é entrada de saldo, não receita.
- **Alterações**: lançamento de cartão em fatura fechada ou com pagamento ativo → valor, data, cartão, tipo e cancelamento bloqueados (409, "use estorno"); descrição e categoria editáveis. Fatura aberta → edição livre com reatribuição de fatura. Compra parcelada: `refund` com `scope: series` cancela parcelas em faturas abertas/futuras e estorna as já faturadas na fatura aberta.
- **Arquivamento**: cartão arquivado não recebe compras (API e agente), mas continua pagável e suas faturas com saldo seguem nas consultas de obrigações; seção "Arquivados" na tela de Cartões. Contas comuns mantêm a regra atual de `deactivate`.
- **Saldo**: `recalculateBalance` passa a `inicial + income − expense + refund − transfer_out + transfer_in` (transfer legado sem direção continua ignorado). "Saldo total" exclui contas de cartão também no dashboard PJ.
- **Competência × caixa**: despesas/categorias usam a data da compra/parcela (competência); fluxo de caixa usa só contas comuns (receitas, despesas, estornos e pernas de pagamento) — compra no cartão não é saída de caixa, o pagamento é. A interface explica a referência de data em cada visão.

## Fase 1 — Separação Contas/Cartões e integridade

**Migração** `…_card_account_integrity`: `credit_cards.due_day` anulável; `closing_day`, `invoice_tracking_start`, `payment_account_id` (FK accounts) novos; insere `credit_cards` para cada `accounts.type = credit_card` sem cartão (mesmo `account_id`, `due_day`/`closing_day` nulos → configuração pendente). Nenhum lançamento é tocado.
**Script read-only** `apps/api/prisma/audit-cards.ts`: lista contas de cartão órfãs, receitas em conta de cartão e despesas em conta comum com "fatura"/"cartão" na descrição (possíveis pagamentos antigos), cartões arquivados com lançamentos. Só relatório.

**API**
- `accounts`: `findAll`/`findOne` só contas comuns (método explícito, sem filtro global); create DTO aceita só tipos comuns (`REGULAR_ACCOUNT_TYPES`); update não aceita `credit_card` e recusa conta interna de cartão (409 → `/credit-cards`); deactivate idem.
- `credit-cards`: `create`, `update`, `remove` (arquivar) atômicos em `prisma.$transaction`; `findAll?includeArchived`; `GET /credit-cards/:id`; DTO com `closingDay`, `dueDay`, `paymentAccountId` (dono validado, conta comum).
- Novo `GET /financial-resources` → `{ accounts, cards }` (cartão com `accountId`, `needsSetup`, `isActive`) para seletores.
- `transactions.validateOwnership` + `internal.createTransactionFromAi`: conta ativa; cartão arquivado recusa compra.
- Agente: `internal.listAccounts` devolve `kind: account|card` (só cartões ativos); `_resolve_account` casa nome nos dois e o fallback passa a ser a primeira `kind == account`; prompt marca cartões. Tests pytest.

**Web** (mobile first): Contas só com contas comuns e sem "Cartão de Crédito"; Cartões concentra criar/editar/arquivar + seção Arquivados; hook `useFinancialResources` + `ResourceSelect` (`<optgroup>` Contas / Cartões, valor = `accountId`, rótulo = nome do cartão) em `TransactionForm`, `RecurrenceForm`, `PendingTransactionsView`.

**Testes**: criação atômica (falha no cartão não deixa conta), bloqueios de create/update/deactivate, listagens separadas, isolamento por usuário, migração (órfã vira cartão com mesmo id), resolver do agente.

## Fase 2 — Visões por conta, cartão, conjunto e consolidado

- **Filtro de recursos** comum: query `accountIds`, `cardIds` (listas) ou nada = consolidado; `ResourceScope.resolve(userId, …)` em `apps/api/src/common/` valida propriedade (400 se id alheio) e devolve `accountId IN (…)`.
- Aplicado em: `transactions.findAll` + novo `GET /transactions/summary` (totais receita/despesa líquida de estornos e por categoria com os **mesmos** filtros, independente da paginação); `dashboard` summary, daily, business e o SQL de `getMonthlyComparison` (`account_id = ANY(...)`); fluxo de caixa PJ em base caixa.
- Corrige o "mês atual" em hora local do servidor nessas agregações para `todaySaoPaulo`.
- **Web**: componente `ResourceFilter` (botão → `Dialog` com checkboxes agrupados, "Todos") com estado na URL (`accounts=`, `cards=`), em Lançamentos e dashboards, combinado com período/categoria/status; páginas `app/pessoal/contas/[id]` e `app/pessoal/cartoes/[id]` (aba "Por período") com totais, categorias e lista paginada (10/página) fixando o recurso. Texto explicando competência × caixa.
- **Testes**: exemplo obrigatório (Alimentação R$ 200 na conta + R$ 350 no cartão = R$ 550 consolidado, 200 e 350 isolados), paginação × totais, id de outro usuário recusado.

## Fase 3 — Faturas, ciclos e limite

**Migração** `…_credit_card_invoices`: tabela `credit_card_invoices` (`id`, `user_id`, `credit_card_id`, `reference_month`, `period_start`, `closing_date`, `due_date`, timestamps; unique `(credit_card_id, reference_month)`); `transactions.invoice_id` (FK, índice). Faturas só são criadas para cartões configurados e lançamentos ≥ `invoice_tracking_start` — cartões legados continuam pendentes.
- `invoice-cycle.ts` (puro) + `CardLedgerService` (`apps/api/src/credit-cards/`): `assign(tx)` usado por transactions create/update, recorrências e internal (IA); `POST /credit-cards/:id/setup` (fechamento, vencimento, `invoiceTrackingStart`, atribui lançamentos elegíveis); mudança de config recalcula faturas futuras.
- `GET /credit-cards/:id/invoices`, `GET …/invoices/:invoiceId` (cobranças, estornos, pagamentos, restante, estados); `toCardView`/`summary` passam a: fatura atual, restante, dívida total, parcelas futuras, limite comprometido/disponível, crédito — nomes batendo com o cálculo; "disponível" rotulado como crédito, não saldo.
- **Web** `cartoes/[id]`: abas "Por período" | "Faturas"; lista e detalhe da fatura; diálogo de configuração para cartões pendentes; cards da tela Cartões com os novos indicadores.
- **Testes** (puros + integração): ciclos com fechamento 28/30/31 em fev/abr, compra no dia do fechamento, vencimento antes/depois do fechamento, mudança de config preserva faturas fechadas, parcelado 3× distribuído em 3 faturas com soma exata dos centavos, fatura atual ≠ parcelas futuras, dívida × limite.

## Fase 4 — Pagamentos, estornos e ajustes

**Migração** `…_card_payments_refunds`: `ALTER TYPE "TransactionType" ADD VALUE 'refund'` (migration própria, sem uso do valor na mesma transação); enum `TransferDirection`; `transactions.transfer_direction`, `card_payment_id`, `refund_of_id`; tabela `card_payments` (`status active|reversed`, `idempotency_key` unique).
- `POST /credit-cards/:id/invoices/:invoiceId/payments` (atômico, idempotente, P2002 tratado como no `internal.service`), `POST …/payments/:paymentId/reverse`, `POST /transactions/:id/refund` (`amount`, `date`, `scope: single|series`); regras de bloqueio em `transactions.update/remove` e `recurrences`.
- Agregações e `recalculateBalance` com `refund` e pernas de transferência; spending goals usam despesa líquida.
- **Web**: diálogo "Pagar fatura" (conta de origem só contas comuns, sugere a preferida, valor padrão = restante, `idempotencyKey` por abertura do diálogo), reverter pagamento, "Estornar" no detalhe do lançamento, mensagens dos bloqueios.
- **Testes**: exemplo obrigatório (compra 100 → despesa 100 e dívida 100; pagamento 100 → conta −100, dívida 0, fatura paga, despesa por categoria continua 100, sem receita); parcial, múltiplos de contas diferentes, repetido com mesma chave, revertido, acima do restante → crédito; estorno total/parcial, estorno de parcelado, edição bloqueada em fatura fechada.

## Arquivos críticos

- `apps/api/prisma/schema.prisma` + 4 migrações novas; `apps/api/prisma/audit-cards.ts`
- `apps/api/src/accounts/{accounts.service,dto/*}.ts`, `apps/api/src/credit-cards/*` (+ `invoice-cycle.ts`, `card-ledger.service.ts`, payments), `apps/api/src/transactions/{transactions.service,recurrences.service,dto/*}.ts`, `apps/api/src/dashboard/dashboard.service.ts`, `apps/api/src/internal/internal.service.ts`, `apps/api/src/spending-goals/*`
- `apps/ai-agent/src/services/{transaction_creator,user_catalog}.py`, `llm/openai_provider.py`
- `apps/web/src/app/app/pessoal/{contas,cartoes}/**`, `components/transactions/{TransactionForm,RecurrenceForm,PendingTransactionsView,TransactionsView}.tsx`, novos `components/resources/{ResourceSelect,ResourceFilter}.tsx`, `hooks/useFinancialResources.ts`, dashboards PF/PJ
- Reusar: `installmentAmounts`, `addMonthsUtc`, `withDay`, `todaySaoPaulo`/`parseDateOnly`/`startOfDayUtc` (`common/date.util.ts`), padrão de idempotência de `internal.service.ts`, `Pagination`, `Dialog`, `Select`, máscaras de `lib/masks.ts`.

## Verificação (a cada fase)

- `pnpm --filter @financial-vellun/api exec prisma migrate deploy` no banco local (backup antes) e `prisma generate` com o dev parado.
- `pnpm --filter @financial-vellun/api exec tsc --noEmit -p tsconfig.build.json`, `jest` completo da API.
- Integração com Postgres real: `SELECTED_FEATURES_TEST_DATABASE_URL=postgresql://…@localhost:5432/financial_vellun_validation` (novos casos no padrão de `selected-features.integration.spec.ts`), incluindo migração sobre dados legados.
- Agente: `.venv\Scripts\python.exe -m pytest -q`.
- Web: `pnpm --filter @financial-vellun/web lint` e `build`; checagem manual em 375px e desktop dos fluxos da fase (criar cartão → aparece só em Cartões; filtro consolidado; pagar fatura).
- Commit por fase; relatório final com mudanças, decisões, migrações, verificações e limitações.

## Limitações conhecidas (a declarar)

- Lançamentos de cartão anteriores ao `invoiceTrackingStart` não ganham fatura retroativa; pagamentos antigos registrados como despesa comum só são apontados pelo `audit-cards.ts`, não reclassificados.
- Juros/tarifas só existem se lançados (como despesa no cartão); nada é presumido.
- Crédito no cartão não é abatido automaticamente de uma fatura específica: reduz a dívida total e aparece como crédito.
