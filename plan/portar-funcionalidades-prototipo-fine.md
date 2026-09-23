# Plano — Portar funcionalidades do protótipo Lovable ("Finê") para o financial-vellun

## Contexto

O protótipo Lovable está em `C:\Users\Bruno Faboci\OneDrive\Documentos\projetos\meu-bolso-zen-71` (o caminho `rails-billing` indicado inicialmente é um backend Rails de billing já coberto pelo módulo NestJS existente). O "Finê" é um app de finanças pessoais/familiares com 13 telas de UI prontas, porém quase tudo mockado (`src/lib/mock-data.ts`) — o valor portável é o **conjunto de funcionalidades, UX e modelo de dados**, não código.

**Gap identificado** (já temos: auth PF/PJ, lançamentos, contas, categorias, contatos, contas a pagar/receber, dashboards, billing, agente IA):
cartões de crédito com fatura, recorrências, metas por categoria, caixinhas, família/membros, lembretes, agenda, anotações e arquivos/comprovantes.

**Escopo aprovado pelo usuário:** todos os grupos (núcleo financeiro + caixinhas + organização + família), **apenas na área pessoal** (`/app/pessoal`), sem tocar a área empresa. Tudo adaptado à arquitetura do monorepo: Prisma + NestJS (`apps/api`), Next.js App Router (`apps/web`), enums/schemas em `packages/shared`. Nada de Supabase.

## Decisões de modelagem (validadas no código)

1. **Cartão de crédito = Account `type=credit_card` + tabela 1:1 `CreditCard`** (brand, limit, closingDay/dueDay 1–28, color). `Transaction.accountId` é obrigatório em todo o código, então despesas de cartão são transactions normais na conta-cartão; saldo negativo = dívida. **Fatura é derivada** (transações do ciclo `(fechamento M-1, fechamento M]`), sem tabela de invoice. Pagamento de fatura = Transaction `transfer` conta bancária → conta-cartão. Dashboard passa a **excluir contas `credit_card` do totalBalance**.
2. **Pré-requisito (Fase 0): completar `transfer`** — hoje `recalculateBalance` ([accounts.service.ts:61-84](apps/api/src/accounts/accounts.service.ts#L61-L84)) ignora transfers e não existe conta destino. Adicionar `transferAccountId` em Transaction; transfer confirmado subtrai da origem e soma no destino; agregados do dashboard já filtram income/expense, então não há dupla contagem.
3. **Recorrências: cron diário** com `@nestjs/schedule` (já instalado e `ScheduleModule.forRoot()` já registrado) — `@Cron` ~04:00 com `timeZone: 'America/Sao_Paulo'`. Modelo `RecurringRule` (type income|expense, amount, frequency enum `monthly` extensível, dueDay 1–31 clampado ao fim do mês, startDate/endDate, isActive). Gera Transaction `source=recurring`, `status=pending` (confirmação via `PendingTransactionsView` existente). **Idempotência**: campos `recurringRuleId` + `competenceMonth "YYYY-MM"` em Transaction com `@@unique([recurringRuleId, competenceMonth])`; capturar P2002. Endpoint manual `POST /recurring-rules/generate` para catch-up/testes.
4. **Metas: tabela própria `CategoryGoal`** (`@@unique([userId, categoryId])`, monthlyGoal) — não campo em Category, pois categorias padrão têm `userId=null` (compartilhadas).
5. **Caixinhas: earmarking virtual** — `SavingsBox` (name, targetAmount, targetDate, color) + `SavingsContribution` (amount, contributedAt, note). Aporte **não gera Transaction** (não distorce relatórios; dinheiro segue na conta). Só aporte positivo no MVP.
6. **Família:** `FamilyMember` (name, role livre, color, isActive) + `memberId` opcional em Transaction (SetNull).
7. **Organização:** `Reminder` (title, amount?, dueDate, isRecurrent, status enum `pending|paid` — **"vencido" derivado por data em America/Sao_Paulo, nunca persistido**); `AgendaEvent` (eventDate `@db.Date` + eventTime string "HH:mm"); `Note` (title, content, isPinned); `FileAttachment` (transactionId? SetNull, fileName original, storagePath relativo, mimeType, sizeBytes).
8. **Upload: disco local via multer** (MVP) — `UPLOAD_DIR` via env, nome em disco = uuid (nunca o original), download só por endpoint autenticado (`StreamableFile`), limites 5 MB e mimetypes `image/*` + `application/pdf`, `StorageService` injetável para trocar por S3 depois. Dev dep `@types/multer`.

## Fases (1 PR por fase, ordenadas por dependência)

### Fase 0 — Transfer completo + saldo sem cartão

- Migration: `transferAccountId` nullable em `transactions`.
- API: `transactions.service.ts` valida `transferAccountId` quando `type=transfer` (ownership, ≠ accountId) e recalcula ambas as contas; `accounts.service.recalculateBalance` considera transfers confirmados (saída −, entrada +); `dashboard.service.getSummary` exclui contas `credit_card` do `totalBalance` (não tocar `getBusinessSummary` além do mesmo ajuste de exclusão — usuários business compartilham `/accounts`; avaliar e aplicar consistentemente).
- Shared: `packages/shared/src/schemas/transaction.ts` ganha `transfer_account_id`.
- Web: `TransactionForm.tsx` mostra select "Conta destino" quando tipo=transferência (Zod refine).

### Fase 1 — Cartões de crédito

- Migration: tabela `credit_cards`.
- API: módulo `credit-cards` (padrão `transactions.controller.ts`: JwtAuthGuard + ActiveSubscriptionGuard, DTOs class-validator + @ApiProperty):
  - `POST /credit-cards` — cria Account `credit_card` + CreditCard na mesma transação Prisma.
  - `GET /credit-cards` — lista com `{ card, currentInvoice: {periodStart, periodEnd, dueDate, total}, outstanding, availableLimit }`.
  - `GET /credit-cards/:id/invoice?month=YYYY-MM` — itens paginados (10/pg).
  - `PATCH /credit-cards/:id`; `DELETE` desativa card+account (bloquear se houver transações, como `accounts.service.deactivate`).
  - `POST /credit-cards/:id/pay-invoice` `{accountId, amount, date}` → Transaction transfer.
- Web: `app/app/pessoal/cartoes/page.tsx` + `components/credit-cards/` (`CreditCardForm`, `CreditCardItem` com fatura/disponível/progresso de limite, `PayInvoiceDialog`). Contas-cartão com badge/agrupadas no `TransactionForm` e filtradas ou marcadas em `/app/pessoal/contas`.
- Nav: "Cartões" em `navItems.individual` ([layout.tsx](apps/web/src/app/app/layout.tsx)).
- Shared: enum `CardBrand`, schema `credit-card.ts`.

### Fase 2 — Recorrências

- Migration: `recurring_rules` + `recurringRuleId`/`competenceMonth` + unique em `transactions`.
- API: módulo `recurring` — CRUD `/recurring-rules` (type restrito a income|expense via `@IsIn`), `RecurringGeneratorService` com cron diário TZ São Paulo (regra ativa com dueDay clampado = hoje e dentro de start/end → cria pending), `POST /recurring-rules/generate`.
- Web: `app/app/pessoal/recorrencias/page.tsx` + `RecurringRuleForm.tsx`; card "Comprometido com fixos" (soma das regras ativas de despesa). Nav: "Recorrências".
- Reutilizar `PendingTransactionsView.tsx` para confirmar gerados; badge de source já existe na lista de lançamentos.

### Fase 3 — Metas por categoria + dashboard

- Migration: `category_goals`.
- API: módulo `goals` — `PUT /goals/:categoryId` (upsert), `DELETE /goals/:categoryId`, `GET /goals/progress?month=` → `[{categoryId, categoryName, color, goal, spent, percentage}]` (mesmo groupBy do [dashboard.service.ts:34](apps/api/src/dashboard/dashboard.service.ts#L34)). `getSummary` ganha `spendingProjection {projected, dailyAverage}` (gasto/diasDecorridos × diasNoMês) e dados de real vs previsto.
- Web: `app/app/pessoal/metas/page.tsx` (barras com faixas: <75% verde, 75–99% amarelo, ≥100% vermelho); dashboard pessoal ganha card "Projeção do mês" e BarChart Recharts "Real vs Previsto" (padrão do gráfico de evolução existente). Nav: "Metas".

### Fase 4 — Caixinhas

- Migration: `savings_boxes`, `savings_contributions`.
- API: módulo `savings-boxes` — CRUD + `POST /savings-boxes/:id/contributions`; `GET` retorna `{..., saved, percentage}`.
- Web: `app/app/pessoal/caixinhas/page.tsx` (cards com Progress + `ContributionDialog`); widget no dashboard (total guardado + top 3). Nav: "Caixinhas".

### Fase 5 — Família

- Migration: `family_members` + `memberId` em `transactions`.
- API: módulo `family` — CRUD `/family-members` + `GET /family-members/spending?month=` (groupBy memberId, despesas confirmadas). `transactions`: `memberId` nos DTOs de create/update (validar ownership) e filtro em `ListTransactionsDto`.
- Web: `app/app/pessoal/familia/page.tsx` (CRUD + BarChart gasto por membro); select "Membro (opcional)" no `TransactionForm`; filtro por membro em lançamentos. Nav: "Família".

### Fase 6 — Organização (lembretes, agenda, notas, arquivos)

- Migration: `reminders`, `agenda_events`, `notes`, `file_attachments`.
- API: 1 módulo `organization` com 4 controllers:
  - `/reminders` CRUD + `POST /reminders/:id/pay` (se isRecurrent, cria o do mês seguinte); service anexa `derivedStatus: 'overdue'` quando pending && dueDate < hoje-SP (usar `Intl.DateTimeFormat('en-CA', {timeZone: 'America/Sao_Paulo'})`, nunca `new Date()` cru).
  - `/agenda-events` CRUD com `?month=`.
  - `/notes` CRUD + `PATCH /notes/:id/pin`.
  - `/files` upload (FileInterceptor multipart, `transactionId?`), listagem, `GET /files/:id/download`, `DELETE` (remove do disco). `StorageService` local-disk.
- Web: `app/app/pessoal/organizacao/page.tsx` com **tabs** (Lembretes | Agenda | Notas | Arquivos) — 1 só item de nav "Organização" para não inflar a sidebar. Componentes em `components/organization/`: `RemindersTab`, `AgendaCalendar` (grade mensal navegável sem lib externa), `NotesTab`, `FilesTab`. Botão "Comprovante" no lançamento (form/lista).
- Dashboard pessoal: lista "Próximas contas a pagar" (top 5 lembretes não pagos).

## Convenções obrigatórias (CLAUDE.md) em todas as fases

- Mobile-first; listas paginadas com **10 itens/página** (passar `limit=10` no front — o default atual da API é 20).
- Máscaras BR (`maskCurrency` etc. de [lib/masks.ts](apps/web/src/lib/masks.ts)) + Zod no front + class-validator no back; moeda enviada como `"1500.00"`.
- Reutilizar `components/ui` (Card, Dialog, Select, Badge, Toast, Confirm), `lib/api-client.ts`, `date.util.ts`/`parseDateOnly` da API.
- Todos os controllers novos com `JwtAuthGuard + ActiveSubscriptionGuard`; DTOs com `@ApiProperty` (Swagger).
- `prisma generate` + rebuild do shared a cada fase; migrations aditivas (colunas nullable/tabelas novas).

## Riscos / pontos de atenção

1. **Transfers existentes**: ao ativar a Fase 0, transfers antigos sem destino passam a subtrair da origem — verificar dados existentes na migração.
2. **Timezone**: o app grava datas ao meio-dia UTC; cron de recorrência e status "vencido" devem derivar "hoje" em America/Sao_Paulo (entre 21h e 0h local o dia UTC já virou).
3. **Bordas de fatura**: `closingDay/dueDay` limitados a 1–28; `dueDay < closingDay` ⇒ vencimento no mês seguinte ao fechamento.
4. **`dueDay=31`** em recorrência: clampar com `endOfMonthUtc`.
5. **Agente IA**: DTOs de `internal/` não mudam (campos novos são opcionais), mas rodar os specs de `internal` e `billing` após cada migration.
6. **Upload**: validar mimetype/size no interceptor E no service; `UPLOAD_DIR` fora do repo; nunca servir estático.

## Verificação por fase (E2E)

- **F0**: transfer 100 entre 2 contas → origem −100/destino +100; cancelar → restaura; não aparece em receitas/despesas do dashboard.
- **F1**: cartão (fech. 10, venc. 20), despesas dia 5 e 15 → fatura atual só com o item do ciclo aberto; compra não muda saldo total do dashboard; pagar fatura → banco cai, devedor zera. Testar UI a 375px.
- **F2**: regra com dueDay = hoje-SP → `generate` cria pending `source=recurring`; rodar 2× não duplica; confirmar atualiza saldo; dueDay=31 em mês de 30 dias.
- **F3**: meta 500 em categoria padrão → gasto 400 = 80% amarelo, ≥500 vermelho; projeção coerente no dashboard.
- **F4**: caixinha 1000 + 2 aportes → progresso correto, nenhuma Transaction criada, saldos intactos.
- **F5**: 2 membros, lançamentos atribuídos → filtro por membro funciona; gráfico soma certo.
- **F6**: lembrete vencido ontem → `derivedStatus` vencido; pagar recorrente cria o próximo mês; upload PNG 1 MB ok + download autenticado; 10 MB ou .exe → 400; agenda navegável entre meses.
- **Transversal**: `pnpm lint`, builds de api/web/shared, specs jest existentes verdes, smoke mobile, formato pt-BR nos valores.

## Arquivos críticos

- `apps/api/prisma/schema.prisma` — todos os modelos novos
- `apps/api/src/accounts/accounts.service.ts` — `recalculateBalance` (F0/F1)
- `apps/api/src/transactions/transactions.service.ts` — transfer, memberId, recurringRuleId
- `apps/api/src/dashboard/dashboard.service.ts` — exclusão de cartão, projeção, metas
- `apps/web/src/app/app/layout.tsx` — novos itens em `navItems.individual`
- `apps/web/src/components/transactions/TransactionForm.tsx` — conta destino, membro, cartão
- `packages/shared/src` — novos enums e schemas Zod
