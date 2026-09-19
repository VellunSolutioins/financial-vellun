# Integrar a main (RabbitMQ/observabilidade/ops) na `feature/melhorias`

## Context

A `feature/melhorias` (37 commits: recorrências, metas, caixinhas, cartões, lembretes, agenda,
anotações, membros Duo, chave Pessoal/Negócio, análise financeira) divergiu da main no merge-base
`bfbb24c`. Nesse meio tempo a main recebeu 48 commits (PRs #10–#13): pipeline durável do
WhatsApp com RabbitMQ + Redis, idempotência de lançamento/extração via IA, observabilidade
(métricas, Loki, correlation-id), área de operações (`/ops`, GitHub OAuth, catálogo de falhas/DLQ,
reprocessamento) e `DataTable`/`Pagination` no web.

A branch **não toca `apps/ai-agent`**, mas mudou o contrato que o agente consome
(`findContactByPhone` agora devolve o dono do household + `createdByUserId`) e tornou
`transactions.created_by_user_id` NOT NULL. Objetivo: trazer a main para a branch, resolver os
conflitos e corrigir as quebras semânticas que o Git não acusa.

Decisão do usuário: idempotência dos 8 novos endpoints `/internal/*/from-ai` **não** entra agora;
fica registrada como pré-requisito para ligar o roteamento no agente.

## Diagnóstico (merge simulado com `git merge-tree`)

**Conflitos textuais (6):** `schema.prisma`, `seed.ts`, `app.module.ts`, `internal.service.ts`,
`app/app/pessoal/lancamentos/page.tsx`, `components/categories/CategoriesView.tsx`.
Auto-merge sem conflito: `.env.example` da API, `create-ai-transaction.dto.ts`,
`internal.service.spec.ts`, `PendingTransactionsView.tsx`, `docker-compose.yml`.

**Quebras semânticas:**
1. **[Crítico] `createdByUserId` ausente no caminho idempotente.** A main reescreveu a criação em
   `persistAiTransaction` (dentro de `$transaction`) sem `createdByUserId`; com a coluna NOT NULL
   da branch, todo lançamento vindo do WhatsApp falha (o `typecheck` da main acusa).
2. **[Alto] Atribuição de membro perdida no WhatsApp.** `contact_service.find_by_phone` repassa o
   JSON inteiro, mas `message_processor`/`transaction_creator` só leem `userId` (= dono) e nunca
   enviam `createdByUserId` → lançamento do membro Duo fica atribuído ao dono.
3. **[Médio — pré-requisito registrado] Endpoints `from-ai` sem idempotência.** Com entrega
   at-least-once + reprocessamento pelo painel de ops, reentrega duplicaria lembrete/nota/aporte
   etc. Hoje o agente não chama esses endpoints, então não quebra nada ainda.
4. **[Baixo] CSRF em `/members/accept-invite`.** A main restringiu a isenção a
   `/auth/login` e `/auth/register` (rotas que *criam* sessão). `accept-invite` também cria sessão
   e deveria estar na lista; hoje só passa pelo fallback de origem permitida.
5. **[Baixo] Ordem das migrations.** As da branch (`20260828…`–`20260830…`, `20260908…`) ficam
   intercaladas/antes das da main (`20260905…`, `20260909…`–`20260911…`). Não há dependência de
   SQL cruzada (tabelas/colunas disjuntas), então `migrate deploy` aplica em qualquer ordem, mas
   ambientes que já rodaram a main receberão migrations "antigas" — validar em banco limpo e num
   banco que já esteja na main.
6. **[Baixo — deploy] Janela NOT NULL.** Se `migrate deploy` rodar antes das réplicas antigas
   saírem, inserts de lançamento do código antigo falham até o rollout terminar. Fazer deploy
   com migrate + troca de réplicas juntos (ou aceitar a janela curta).

**Verificado e sem ação:** crons da branch (`recurring-rules`, `savings-boxes`) são idempotentes
por índice único, então rodar em várias réplicas é seguro; `sanitizeForLog` já redige
`token`/`password` do convite; nenhum código de ops/billing da main depende de códigos de plano;
exporter do Postgres usa `postgres:5432` na rede Docker, sem conflito com a porta 5433 da branch.

## Passos

### 1. Merge
`git merge origin/main` na `feature/melhorias` (merge, não rebase: a branch já passou por PR/review).

### 2. Resolver conflitos
- **`apps/api/prisma/schema.prisma`**: união dos dois lados. Em `Transaction`, manter
  `createdByUserId`, campos de recorrência/parcelas **e** `idempotencyKey @unique`. Manter enums/
  models de ops e as colunas novas de `PaymentWebhookEvent`/`AiExtractedTransaction` da main.
  Depois: `prisma format` e `prisma migrate diff --from-migrations … --to-schema-datamodel …` sem
  diferença (nenhuma migration nova deve ser necessária).
- **`apps/api/prisma/seed.ts`**: ficar com o `localDevPlan` da branch (`maxMembers: 2`,
  `commonFeatures`) e o bloco `retiredPlanCodes`; aplicar a formatação multi-linha da main nos
  `console.warn/log`.
- **`apps/api/src/app.module.ts`**: `ObservabilityModule` logo após `PrismaModule` (tem de ser o
  primeiro por causa do middleware de correlação), os módulos da branch em seguida e `OpsModule`
  no fim.
- **`apps/api/src/internal/internal.service.ts`**: base = versão da main (idempotência,
  `ensureContact`, `resolveActiveConversation`, `Logger`, `ConflictException`) + da branch:
  imports/injeções dos 7 services, `findContactByPhone` com `householdOwnerId` e
  `createdByUserId`, e os 8 métodos `create*FromAi`. **Em `persistAiTransaction` adicionar
  `createdByUserId: dto.createdByUserId ?? dto.userId`** (corrige o item 1).
- **`apps/web/src/components/categories/CategoriesView.tsx`**: versão `DataTable` da main +
  prop `profileType` da branch (query `?profileType=`, dependência do `useEffect` e
  `profileType: editing ? undefined : profileType` no payload).
- **`apps/web/src/app/app/pessoal/lancamentos/page.tsx`**: manter o layout da branch (sem colunas
  Conta/Origem/Status, detalhes pelo ícone de olho, `limit: 10`). Levar a intenção da main para
  esse layout: selo "IA" junto da descrição quando `source ∈ {'ai','whatsapp'}` (reusar a const
  `REGISTRADO_PELA_IA` da main) e trocar a paginação manual pelo `Pagination` de
  `components/ui/pagination.tsx`. Checar em mobile e desktop.

### 3. Propagar `createdByUserId` no agente (item 2)
- `apps/ai-agent/src/services/message_processor.py`: em `process` ler
  `created_by = contact.get("createdByUserId")` e passar para `handle_intent` (novo kwarg
  `created_by_user_id: str | None = None`), que repassa para `transaction_creator.create_from_intent`.
- `apps/ai-agent/src/services/transaction_creator.py`: novo kwarg `created_by_user_id`; se
  presente, `payload["createdByUserId"] = created_by_user_id`.
- Mídia (`inbound_consumer._handle_media` / `media_processor`): comprovante chega pelo
  `ProcessingJobV1.preExtractedIntent` e volta a passar por `message_processor.process`, que busca
  o contato de novo — então não precisa mudar o contrato do broker. Confirmar que não há outro
  caminho que chame `handle_intent` direto; se houver, passar o mesmo kwarg.
- Atualizar a docstring de `contact_service.find_by_phone` (`{userId, createdByUserId, …}`).
- Testes: em `tests/test_message_processor.py` adicionar caso "contato membro" → payload do POST
  `/internal/transactions/from-ai` contém `createdByUserId`; caso sem o campo continua sem ele.

### 4. Ajustes na API
- `apps/api/src/common/guards/csrf.guard.ts`: incluir `/members/accept-invite` em
  `AUTH_CSRF_EXEMPT_PATHS`, com uma linha no comentário ("cria sessão, como register") e um
  caso em `csrf.guard.spec.ts`.
- `apps/api/src/internal/internal.service.spec.ts` (auto-merge): o construtor tem 10 parâmetros
  e o spec passa 3. O ts-jest checa tipos, então completar com mocks `{} as any` se quebrar.
  Adicionar asserção de que `createdByUserId` vai no `tx.transaction.create` (com e sem o campo
  no DTO) e um teste de membro no `findContactByPhone`.

### 5. Documentação
- `CLAUDE.md` (versão da main após o merge): acrescentar à árvore `apps/api/src/` os módulos da
  branch (`agenda-events/ credit-cards/ financial-analysis/ members/ notes/ recurring-rules/
  reminders/ savings-boxes/ spending-goals/`) e atualizar a Fase 5 (recorrência/metas já
  entregues em parte).
- `docs/whatsapp-flow-gap-analysis.md` (da main): registrar como **pré-requisito bloqueante**
  para rotear as novas intenções no agente: (a) `idempotencyKey` (jobId) nos 8 endpoints
  `/internal/*/from-ai`, seguindo o padrão de `createTransactionFromAi` + `assertIdempotencyOwner`;
  (b) enviar `createdByUserId` onde o recurso tiver autoria; (c) considerar contas/categorias
  pelo contexto Pessoal/Negócio (hoje `listCategories` usa só o `profileType` do cadastro).

## Arquivos críticos
- `apps/api/prisma/schema.prisma`, `apps/api/prisma/seed.ts`, `apps/api/src/app.module.ts`
- `apps/api/src/internal/internal.service.ts` (+ `.spec.ts`)
- `apps/api/src/common/guards/csrf.guard.ts` (+ `.spec.ts`)
- `apps/ai-agent/src/services/message_processor.py`, `transaction_creator.py`, `contact_service.py`
- `apps/web/src/app/app/pessoal/lancamentos/page.tsx`, `apps/web/src/components/categories/CategoriesView.tsx`
- `CLAUDE.md`, `docs/whatsapp-flow-gap-analysis.md`

## Verificação
1. `pnpm install` (lockfile da main traz deps novas) e `pnpm prisma:generate`.
2. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`.
3. `pnpm --filter @financial-vellun/api test` e `pnpm test:agent` (pytest sem os de integração).
   Com `pnpm infra:up` no ar: `.venv\Scripts\python.exe -m pytest -m integration -q`.
4. Migrations: `prisma migrate reset` num banco limpo (ordem completa + seed) **e** num banco que
   esteja só com as migrations da main: `migrate deploy` deve aplicar as da branch sem erro;
   `prisma migrate diff` sem drift.
5. E2E local (`pnpm dev` + `pnpm agent:worker`): mandar mensagem pelo WhatsApp (ou
   `scripts/loadtest.py`) como dono e como membro Duo → lançamento criado uma vez, com
   `created_by_user_id` correto; reprocessar o mesmo job pelo painel `/ops/falhas` → sem duplicata
   (`idempotent: true`). Conferir no web o selo "IA" em Lançamentos, a paginação de 10 itens e a
   tela de Categorias com a chave Pessoal/Negócio.
6. Aceitar convite de membro com um cookie de sessão antigo no navegador → 201 e sessão criada.
