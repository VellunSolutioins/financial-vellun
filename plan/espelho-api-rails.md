# Espelho da API em Rails — `apps/api-rails`

## Contexto

Hoje o backend do produto é `apps/api` (NestJS 10 + Prisma 5 + PostgreSQL): ~40 rotas HTTP
distribuídas em 10 módulos, com autenticação por cookie httpOnly + CSRF double-submit,
guard de assinatura, integração com o PSP Asaas (checkout, webhook, máquina de estados,
reconciliação horária) e um conjunto de rotas `/internal` que servem o agente de IA em
Python.

O objetivo é criar uma **segunda implementação da mesma API em Ruby on Rails**, com
paridade de contrato: mesmas rotas, mesmos payloads de entrada, mesmos corpos de resposta
e mesmos códigos de erro. A intenção é poder subir as duas lado a lado e comparar respostas
endpoint a endpoint — `apps/web` e `apps/ai-agent` devem funcionar apontando para qualquer
uma das duas sem alteração.

### Baseline e um delta importante

`docs/backend-flows.md` foi escrito na branch `feat/implements-password-recovery` e
descreve **um superconjunto** da `main`. O que está no documento mas **não** está na `main`:

| Item no documento | Situação real |
| --- | --- |
| `POST /auth/forgot-password` · `POST /auth/reset-password` | só em `feat/implements-password-recovery` |
| `MailService` + transports `log` / `resend` | idem |
| Tabela `password_reset_tokens` (migration + schema) | idem |

Decisão tomada: **incluir**. O baseline efetivo do espelho é
`main + origin/feat/implements-password-recovery` (diff de 16 arquivos, ~498 linhas).

Outros pontos onde o documento diverge do código e o Rails deve seguir o **código**:

- O webhook do Asaas **não usa HMAC**. É um token estático comparado em tempo constante
  (header `asaas-access-token` vs `ASAAS_WEBHOOK_TOKEN`) — ver `asaas-payment.provider.ts`.
- A "DLQ" do processador de webhook não é uma tabela: é a própria linha de
  `payment_webhook_events` deixada em `status = 'failed'` com `last_error`.
- `POST /billing/payment-method` existe na rota mas o adapter Asaas lança
  `NotImplementedException` (501). Espelhar o 501.

---

## Persistência — decidido

**Banco novo, migrations Rails próprias e idiomáticas, PK `TEXT` com UUID.** Os dados de
homologação entram por `pg_dump --data-only`. O Rails passa a ser dono do schema; o Prisma
continua conseguindo ler o mesmo formato, o que preserva a operação lado a lado até o cutover.

### Por que essa combinação funciona

A verificação do DDL real mostrou que **o schema físico já segue as convenções do
ActiveRecord**, porque os `@@map`/`@map` do Prisma foram escritos em snake_case plural:

| Aspecto | Postgres hoje | O que o Rails infere | Bate? |
| --- | --- | --- | --- |
| Tabelas | `users`, `accounts`, `individual_profiles`, `whatsapp_contacts`, `ai_extracted_transactions`, `payment_webhook_events`, `subscription_audits`… | idem (inflector) | ✅ 16/16 |
| Colunas | `password_hash`, `profile_type`, `provider_message_id`, `is_active`… | snake_case | ✅ 100% |
| PK | coluna `id` | coluna `id` | ✅ |
| FKs | `user_id`, `account_id`, `plan_id`, `conversation_id`, `whatsapp_contact_id`… | idem | ✅ |
| Timestamps | `created_at` / `updated_at` | idem | ✅ |

Nenhum `self.table_name` é necessário. Todo nome camelCase no `schema.prisma` é campo
virtual de relação, não coluna.

### O que muda e o que fica

| Fica no padrão Rails (seguro) | Permanece como está (necessário) |
| --- | --- |
| Nomes de índice `index_*_on_*` | **PK `TEXT`** com UUID gerado na aplicação |
| Nomes de FK `fk_rails_*` | 14 **enums nativos** via `create_enum` |
| `t.timestamps precision: 6` | `DECIMAL(15,2)` em dinheiro |
| Migrations versionadas em `db/migrate` | `transaction_date` como `DATE` |
| `db/seeds.rb` | `jsonb` em `metadata`, `extracted_payload`, `features`, `sanitized_payload` |

Nomes de índice/FK e precisão de timestamp são **cosméticos para a carga de dados** —
`pg_dump --data-only` não carrega esse metadado, e `TIMESTAMP(3) → TIMESTAMP(6)` é
alargamento lossless.

**A PK é o único item que não pode mudar.** `bigint` exigiria reescrever ~20 colunas de FK
em 17 tabelas e quebraria ids que já vazaram para fora do banco (o Asaas guarda `userId` em
`externalReference`; a auditoria da IA amarra `transaction_id` e `source_message_id`; o front
tem URLs com id de lançamento). `uuid` nativo preservaria os dados, mas obrigaria `@db.Uuid`
em ~37 campos do `schema.prisma` — ou seja, mataria a operação lado a lado e, com ela, o
harness de comparação que é o mecanismo central de verificação deste plano.

### Pontos de implementação

1. **`config.active_record.schema_format = :sql`** → `db/structure.sql`. Enums nativos e PK
   `TEXT` não são representáveis com fidelidade em `schema.rb`. Consequência: o CI precisa do
   cliente `psql` para `db:test:prepare`.
2. **Geração de ID** — concern no `ApplicationRecord` com `before_create { self.id ||= SecureRandom.uuid }`.
   Espelha o que o Prisma faz. *(Alternativa em aberto: `DEFAULT gen_random_uuid()::text` no
   banco, como reforço para escritas via SQL cru. Retrocompatível, mas ainda não decidido.)*
3. **Enums** — `create_enum 'ProfileType', %w[individual business]` etc. O nome do tipo precisa
   preservar o **PascalCase** (identificador citado); sem aspas o Postgres rebaixa para
   minúsculas e o Prisma deixa de reconhecer o tipo.
4. **Associações sem `dependent:`** — todas as regras de cascade/set-null já estão nas FKs do
   banco. Declarar `dependent: :destroy` duplicaria o trabalho com semântica diferente.
   Uma associação precisa de `class_name` explícito:
   `belongs_to :source_message, class_name: 'AiMessage'` em `AiExtractedTransaction`.
5. **`ai_messages` e `subscription_audits` só têm `created_at`.** Não usar `t.timestamps` nessas
   duas — criaria um `updated_at NOT NULL` sem dado correspondente no dump.
6. **`updated_at` é `NOT NULL` sem default.** Escritas fora do AR (`update_all`, `insert_all`,
   SQL cru) precisam preencher explicitamente.
7. **`config.active_record.default_timezone = :utc`** (o default). As colunas são
   `timestamp without time zone` e o Prisma grava em UTC — trocar para `:local` reinterpretaria
   tudo como America/Sao_Paulo e deslocaria 3h.
8. **17 models** — os 16 da `main` mais `password_reset_tokens` (hoje só na branch de
   recuperação de senha: `id`, `user_id`, `token_hash` único, `expires_at`, `used_at`,
   `created_at`, FK cascade).
9. **Grafias que não podem ser "corrigidas"**: `TransactionStatus.cancelled` (dois L) vs
   `SubscriptionStatus.canceled` / `PaymentStatus.canceled` (um L).
10. **Seeds** — portar `prisma/seed.ts` para `db/seeds.rb` mantendo a idempotência: categorias
    padrão casadas por `user_id IS NULL + is_default + name + type + profile_type`; planos por
    `code`. Os hashes bcrypt são portáveis (o gem `bcrypt` lê o que o `bcryptjs` gerou).

### Carga dos dados de homologação

1. Subir o schema novo pelas migrations Rails, **sem as FKs** (ou com elas desabilitadas).
2. `pg_dump --data-only --no-owner` do banco atual, excluindo `_prisma_migrations`.
3. Restaurar com `pg_restore --disable-triggers` **ou** carregar antes de criar as FKs —
   `--data-only` não ordena por dependência e violaria as constraints.
4. Criar/reativar as FKs e rodar uma contagem por tabela contra a origem.
5. Não há sequences a reajustar (nenhuma coluna `serial`).

### Riscos residuais

- **Duas ferramentas de migration existindo em paralelo.** `_prisma_migrations` e
  `schema_migrations` vivem em bancos diferentes agora, então não há conflito técnico — o risco
  é humano. Regra: a partir daqui, mudança de schema entra pelo Rails, e o `schema.prisma` só é
  atualizado se a API Nest ainda precisar do campo.
- **Divergência de dados entre os dois bancos** durante a coexistência. O harness de comparação
  precisa rodar contra um snapshot conhecido, não contra dois bancos vivos.
- **`password_reset_tokens`** não está na `main`. Ou a branch entra antes, ou o Rails nasce dono
  dessa tabela e o Prisma fica desatualizado nesse ponto.
- **Docker de dev** (`infra/docker/docker-compose.yml`) sobe um Postgres só — precisa de um
  segundo database no mesmo container.

---

## Estrutura alvo

```
apps/api-rails/                 # fora do pnpm workspace — só Gemfile/bundler
├── Gemfile
├── config/
│   ├── application.rb          # api_only, schema_format :sql, time_zone
│   ├── routes.rb               # espelho literal do mapa de rotas
│   ├── initializers/
│   │   ├── cors.rb             # rack-cors ← isAllowedWebOrigin
│   │   ├── rack_attack.rb      # ← ThrottlerModule + @Throttle
│   │   ├── secure_headers.rb   # ← helmet
│   │   └── json_encoding.rb    # camelCase + precisão de datas/decimais
├── db/
│   ├── migrate/                # 17 tabelas + 14 create_enum
│   ├── structure.sql
│   └── seeds.rb                # ← prisma/seed.ts
├── app/
│   ├── controllers/
│   │   ├── application_controller.rb   # cadeia de "guards" + envelope de erro
│   │   ├── concerns/{jwt_authenticatable,csrf_protectable,
│   │   │             active_subscription_required,internal_api_key}.rb
│   │   ├── auth_controller.rb  users_controller.rb  accounts_controller.rb
│   │   ├── categories_controller.rb  contacts_controller.rb
│   │   ├── transactions_controller.rb  dashboard_controller.rb
│   │   ├── billing_controller.rb  billing_webhooks_controller.rb
│   │   └── internal/*.rb
│   ├── contracts/              # ← DTOs class-validator (dry-schema)
│   ├── serializers/            # ← formato de saída do Prisma (camelCase)
│   ├── models/                 # 17 models; application_record.rb gera o UUID
│   ├── services/
│   │   ├── auth/  billing/  internal/  dashboard/  mail/
│   └── jobs/                   # webhook processor + reconciliação
└── spec/                       # RSpec: request specs por rota
```

Porta **3002** (a Nest fica na 3001), script `api-rails:dev` no `package.json` da raiz.

---

## Mapeamento de tecnologias

| NestJS | Rails | Observação |
| --- | --- | --- |
| `@nestjs/jwt` HS256, 15m/7d | gem `jwt` + `Auth::TokenService` | payload `{ sub, email, iat, exp }` — precisa ser idêntico byte a byte para os dois backends aceitarem o cookie um do outro |
| `passport-jwt` + `JwtAuthGuard` | concern `JwtAuthenticatable` | extrai do cookie `access_token`, recarrega o usuário do banco (o Nest expõe o registro inteiro em `req.user`) |
| `CsrfGuard` global | concern `CsrfProtectable` em `before_action` | **não usar** o CSRF nativo do Rails: a regra é específica (isenta `/auth/*`, isenta requisição sem cookie de sessão, double-submit, fallback por `Origin`) |
| `ValidationPipe` `{whitelist, transform, forbidNonWhitelisted}` | gem `dry-schema` (contracts) | `forbidNonWhitelisted` → chave desconhecida deve dar **400**, não ser ignorada. Strong Parameters sozinho não replica isso |
| `class-validator` (`@IsEmail`, `@Matches`, …) | regras dry-schema + validadores de CPF/CNPJ portados de `common/document.util.ts` | as regex de máscara do CLAUDE.md são as mesmas |
| `@nestjs/throttler` global 120/min | `rack-attack` | + overrides: `auth/login` e `auth/register` 5/min, `forgot`/`reset` 5/15min, `billing/checkout` e `payment-method` 10/min, `@SkipThrottle` em `/internal` e `/billing/webhook` |
| `helmet` | gem `secure_headers` | CSP só em produção |
| CORS dinâmico | `rack-cors` + porte de `http-origin.util.ts` | inclui a regex de preview da Vercel |
| `@nestjs/swagger` | gem `rswag` | doc gerada a partir das request specs; desabilitada em produção |
| `fetch` + retry (`asaas.http-client.ts`) | `faraday` + `faraday-retry` | timeout 10s, 2 retries só em idempotente, backoff `2**n * 250ms`, aborta em `< 500` |
| `setImmediate` (webhook) | ActiveJob | ver "Decisões de execução" abaixo |
| `@Cron(EVERY_HOUR)` | ActiveJob recorrente / `rufus-scheduler` | idem |
| Serialização do Prisma | gem `alba` com `transform_keys :lower_camel` | ver "Fidelidade de serialização" |
| Jest (16 spec files, 109 casos) | RSpec + factory_bot + webmock | os specs de billing/CSRF/internal do Nest são a melhor spec funcional que existe — portar caso a caso |

### Decisões de execução (onde o espelho pode melhorar sem quebrar contrato)

O processador de webhook do Nest agenda retries com `setTimeout` **em processo** — perde
tudo em restart. O cron de reconciliação usa um booleano em memória como lock.

Recomendação: usar **ActiveJob com adapter `:async` em dev** (paridade de comportamento) e
deixar o adapter plugável para Solid Queue/Sidekiq em produção. O contrato HTTP não muda —
o webhook continua respondendo `200 {received, duplicate}` imediatamente. As colunas
`status` / `attempts` / `last_error` de `payment_webhook_events` continuam sendo a fonte de
verdade, então a lógica de idempotência é idêntica.

---

## Fidelidade de serialização — o ponto mais fácil de errar

O `apps/web` consome o formato do Prisma. Divergir aqui quebra o front silenciosamente.

| Caso | Prisma/Nest emite | Rails emitiria por padrão | Ação |
| --- | --- | --- | --- |
| Nomes de campo | `camelCase` (`currentBalance`, `transactionDate`) | `snake_case` | `alba` com `transform_keys :lower_camel`; **e** os contracts precisam aceitar camelCase na entrada |
| `Decimal(15,2)` | string `"1500.00"` | `"1500.0"` (BigDecimal) | formatar com `to_s('F')` + 2 casas fixas no serializer |
| `DateTime` | `"2026-07-27T12:00:00.000Z"` | `"2026-07-27T12:00:00.000Z"` ✅ | manter `time_precision = 3` e `Time.zone = 'UTC'` |
| `transaction_date` (coluna `DATE`) | `"2026-07-27T00:00:00.000Z"` | `"2026-07-27"` ❌ | serializar como datetime meia-noite UTC |
| Erro de validação | `{statusCode: 400, message: ["..."], error: "Bad Request"}` | `{errors: {...}}` | `rescue_from` central produzindo o envelope do Nest |
| Erro de negócio | `{statusCode: 403, code: "SUBSCRIPTION_REQUIRED", message: "..."}` | — | exceções de domínio com `code` |
| Relações | `include: {category, account}` → objetos aninhados | — | serializers aninhados nos mesmos endpoints |

### Semânticas de data que precisam ser portadas literalmente

De `apps/api/src/common/date.util.ts` e `billing/providers/asaas/asaas.mapper.ts`:

- `parseDateOnly("2026-07-27")` → **12:00 UTC** (evita o "volta um dia" em UTC-3).
- Filtros de período usam `startOfDayUtc` (00:00:00.000 UTC) / `endOfDayUtc` (23:59:59.999 UTC).
- Datas do Asaas (`YYYY-MM-DD`) também são ancoradas em **12:00 UTC**.
- `AsaasPaymentProvider#today` usa **America/Sao_Paulo** deliberadamente, não UTC.
- `process.env.TZ = 'America/Sao_Paulo'` no bootstrap → em Rails, `config.time_zone` para a
  aritmética de dashboard, mas serialização em UTC.

E de `common/phone.util.ts`: `normalize_phone` → E.164 assumindo DDI `55` para 10/11 dígitos.
É o que faz o vínculo do WhatsApp resolver.

---

## Fase 1a — Fundação e schema

1. `rails new apps/api-rails --api --database=postgresql --skip-active-storage --skip-action-mailbox --skip-action-text --skip-action-cable --skip-test`
   e remover a app do escopo do pnpm (`pnpm-workspace.yaml` já usa `apps/*` — adicionar
   exclusão ou apenas não criar `package.json`).
2. Gemfile com o mapeamento acima; RSpec + factory_bot + webmock.
3. **Schema**: `schema_format = :sql`, as 14 `create_enum`, as 17 tabelas, o concern de
   geração de UUID no `ApplicationRecord`, os models com as associações (sem `dependent:`),
   `db/seeds.rb` portado, e o segundo database no `docker-compose`. Ver "Persistência" acima.
4. **Cadeia de middleware equivalente ao `main.ts`**, na mesma ordem:
   `secure_headers` → `rack-cors` → cookies → `rack-attack` → CSRF → JWT → assinatura.
5. **Envelope de erro central** (`ApplicationController#rescue_from`) reproduzindo o formato
   de `HttpException` do Nest, incluindo `message` como array em erro de validação.
6. **Camada de contracts** (dry-schema) com o comportamento `forbidNonWhitelisted`, e os
   validadores de CPF/CNPJ portados de `common/document.util.ts` (6 casos de teste no Nest).
7. `GET /` → `{ status: 'ok' }`; `rswag` montado em `api/docs` fora de produção.
8. **Harness de comparação**: script que dispara a mesma requisição contra `:3001` e `:3002`
   e faz diff dos JSONs. É o que transforma "espelho" em algo verificável.

Arquivos-fonte de referência: [main.ts](../apps/api/src/main.ts),
[csrf.guard.ts](../apps/api/src/common/guards/csrf.guard.ts),
[http-origin.util.ts](../apps/api/src/common/http-origin.util.ts),
[document.util.ts](../apps/api/src/common/document.util.ts),
[app.module.ts](../apps/api/src/app.module.ts).

## Fase 1b — Núcleo do produto

Os 5 domínios sobre os models da Fase 1a. Rotas e regras já levantadas:

| Rota | Guards | Regra que não pode ser perdida |
| --- | --- | --- |
| `POST /auth/register` | throttle 5/min | 4 checagens de unicidade → 409; `bcrypt` cost 12; **transação única** criando User + perfil + Account "Conta Principal" + upsert `whatsapp_contacts`; depois boas-vindas *fire-and-forget* |
| `POST /auth/login` | throttle 5/min | seta 3 cookies (`access_token` 15m, `refresh_token` 7d, `csrf_token` 7d não-httpOnly) |
| `POST /auth/refresh` | JwtRefresh | sem rotação/allowlist no banco — espelhar assim |
| `GET /auth/me` | Jwt | reemite o cookie CSRF; retorna usuário sem `passwordHash` + `hasProfile` |
| `POST /auth/forgot-password` · `reset-password` | throttle 5/15min | resposta genérica sempre; só o SHA-256 do token no banco; uso único; TTL 1h |
| `GET/POST/PATCH /users/me*` | Jwt (sem assinatura) | `PATCH /users/me` revincula o WhatsApp (409 se o número é de outro usuário) |
| `accounts` | Jwt + Assinatura | `DELETE` = desativação; 400 se houver lançamento não-`cancelled` |
| `categories` | Jwt + Assinatura | filtro `profileType = user.profileType AND (userId = me OR (isDefault AND userId IS NULL))`; 403 ao mexer em `isDefault` |
| `contacts` | Jwt + Assinatura | `DELETE` = soft delete |
| `transactions` | Jwt + Assinatura | paginação `{data, meta}`; `categoryId: 'uncategorized'` → `NULL`; `categoryId: ''` → `null` no update; `DELETE ?hard_delete=true`; **saldo sempre recalculado, nunca incrementado** |
| `dashboard` (3 rotas) | Jwt + Assinatura | query params em **snake_case** (`period_start`, `period_end`, `month`) — divergem do resto da API |

Referências: [auth.service.ts](../apps/api/src/auth/auth.service.ts),
[transactions.service.ts](../apps/api/src/transactions/transactions.service.ts),
[accounts.service.ts](../apps/api/src/accounts/accounts.service.ts),
[dashboard.service.ts](../apps/api/src/dashboard/dashboard.service.ts).

## Fase 2 — Rotas `/internal` (destrava o agente de IA)

7 rotas sob `InternalApiKeyGuard` (`x-internal-api-key`, `timingSafeEqual`), `SkipThrottle`,
fora do Swagger. É a fase que permite apontar `MAIN_API_URL` do agente Python para o Rails.

- `GET /internal/whatsapp/contacts/:phone` · `.../messages?limit=`
- `GET /internal/users/:userId/categories` · `/accounts` · `/subscription-access`
- `POST /internal/transactions/from-ai`
- `POST /internal/ai-events` (message · extraction)

Pontos críticos:
- **Três camadas de deduplicação** em `ai-events`: pré-checagem por `providerMessageId`,
  criação, e captura da corrida no unique (`P2002` no Prisma → `ActiveRecord::RecordNotUnique`),
  que relê e devolve `duplicate: true`.
- `metadata.timestamp` do provedor é **Unix em segundos**.
- `assertCanUseProduct` (403 `SUBSCRIPTION_REQUIRED`) só se aplica a *categories*, *accounts*
  e *transactions/from-ai* — **não** a contatos, mensagens, `subscription-access` nem `ai-events`.
- `subscription-access` **nunca** lança exceção (o agente é fail-closed do outro lado).

Referências: [internal.service.ts](../apps/api/src/internal/internal.service.ts) e seu
[spec](../apps/api/src/internal/internal.service.spec.ts) (14 casos — portar direto).

## Fase 3 — Billing / Asaas

O maior bloco: ~35 arquivos no Nest. Sub-partes, em ordem:

1. **Porta `PaymentProvider`** (9 métodos) + adapter Asaas + HTTP client com retry.
2. **Mappers** — status de assinatura/pagamento, ciclo, `parseDate` em 12:00 UTC.
3. **Máquina de estados** (`ALLOWED_TRANSITIONS`), `TRIAL_DAYS = 30`, `GRACE_DAYS = 3`,
   `isCancellationDeferred`, `computePeriodEnd`. Transição inválida = **no-op com warning**,
   nunca erro — é o que torna replay de webhook inofensivo.
4. **`SubscriptionAccessService`** — fonte única de verdade, usada pelo guard HTTP e pelo
   canal de IA. Flag `BILLING_ENFORCEMENT_ENABLED !== 'false'`.
5. **Webhook**: verificação por token estático → `ingest` (idempotência pelo unique
   `provider_event_id`) → resposta `200` imediata → processamento assíncrono com
   `MAX_ATTEMPTS = 5` e backoff `2**n * 500ms`. `sanitizePayload` redige
   `/(card|ccv|cvv|cvc|token|secret|password)/i` **antes** de persistir.
6. **Endpoints públicos**: `plans`, `subscription`, `checkout` (plano grátis curto-circuita o
   PSP; `assertBillingProfileComplete` exige telefone + CEP + logradouro + número + bairro),
   `payment-method` (501), `cancel`.
7. **Reconciliação horária**, lote 200, `orderBy updatedAt asc`.

Referências: [billing.service.ts](../apps/api/src/billing/billing.service.ts),
[webhook.processor.ts](../apps/api/src/billing/webhook/webhook.processor.ts),
[subscription-state.service.ts](../apps/api/src/billing/services/subscription-state.service.ts),
[asaas-payment.provider.ts](../apps/api/src/billing/providers/asaas/asaas-payment.provider.ts),
[reconciliation.service.ts](../apps/api/src/billing/reconciliation.service.ts).
Os 11 specs de `webhook.processor.spec.ts`, 14 de `subscription-state` e 11 de
`subscription-access` são a especificação executável desta fase.

---

## Verificação

Por fase, nesta ordem:

1. **Specs unitárias portadas.** Os 16 arquivos `.spec.ts` do Nest (109 casos) viram specs
   RSpec. São a rede de segurança das regras de domínio — especialmente CSRF (11 casos),
   `subscription-state` (14) e `internal.service` (14).
2. **Request specs por rota.** O Nest **não tem nenhum teste de controller/rota** (`supertest`
   está instalado e não é usado, e `test/jest-e2e.json` nem existe). Aqui o Rails sai na
   frente: uma request spec por rota, cobrindo o corpo de resposta completo.
3. **Diff de contrato entre as duas APIs.** Com as duas no ar (`:3001` e `:3002`), o script
   da Fase 1a dispara a mesma sequência autenticada nas duas e compara os JSONs campo a
   campo. É o teste que realmente prova "espelho".
4. **Asaas com `webmock`** — respostas gravadas do PSP; nunca chamada real em teste.
5. **Fumaça ponta a ponta**: `pnpm web:dev` apontando para `:3002` (`NEXT_PUBLIC_API_URL`)
   e fluxo cadastro → login → criar conta → criar lançamento → dashboard. Depois
   `apps/ai-agent` com `MAIN_API_URL=http://localhost:3002` e uma mensagem simulada no
   webhook (`WHATSAPP_PROVIDER=log`) até virar lançamento.

---

## Ponto ainda em aberto

**Geração de ID** — o concern no `ApplicationRecord` (`SecureRandom.uuid`) é o caminho
assumido, espelhando o Prisma. Falta decidir se acrescentamos também
`DEFAULT gen_random_uuid()::text` nas colunas `id` como reforço para escritas via SQL cru.
Não bloqueia nada: é uma migration de uma linha por tabela, adicionável depois.

Antes da carga de homologação, vale confirmar que todo id é UUID válido:

```sql
SELECT 'users' AS t, count(*) FROM users
 WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
UNION ALL
SELECT 'transactions', count(*) FROM transactions
 WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
-- repetir para as 17 tabelas
```

Com PK `TEXT` um resultado > 0 não quebra a carga (a coluna aceita qualquer string), mas
indicaria dado gerado fora do Prisma — vale entender de onde veio antes de migrar.
