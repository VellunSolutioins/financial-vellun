# Plano de Execução — Gateway de Pagamento (Asaas) + Assinaturas

## Context

O documento [payment-gateway-implementation-plan.md](payment-gateway-implementation-plan.md) define a estratégia de cobrança recorrente do Financial Vellun: somente usuários com assinatura vigente podem usar o produto, via **Asaas** (checkout hospedado + webhooks, cartão de crédito recorrente em BRL). Hoje o produto não tem nenhuma noção de estado comercial:

- `User` não tem assinatura nem estado comercial ([apps/api/prisma/schema.prisma](../apps/api/prisma/schema.prisma) linha 71);
- `JwtAuthGuard` só valida identidade ([apps/api/src/auth/guards/jwt-auth.guard.ts](../apps/api/src/auth/guards/jwt-auth.guard.ts));
- o módulo `internal` (usado pela IA) libera por telefone sem checar assinatura ([apps/api/src/internal/controllers/internal.controller.ts](../apps/api/src/internal/controllers/internal.controller.ts));
- o WhatsApp gasta com LLM/STT/Vision sem qualquer verificação ([apps/ai-agent/src/services/message_processor.py](../apps/ai-agent/src/services/message_processor.py), [apps/ai-agent/src/services/media_processor.py](../apps/ai-agent/src/services/media_processor.py));
- o [apps/web/src/middleware.ts](../apps/web/src/middleware.ts) não protege rotas.

O objetivo deste plano é transformar a estratégia em **prompts incrementais e sequenciais** de implementação. Cada prompt é auto-contido, depende apenas dos anteriores e termina num estado testável.

### Decisões de produto (fechadas com o usuário)

| Item | Decisão |
| --- | --- |
| Trial | **30 dias** (estado `trialing` + `trialEndsAt`) |
| Grace period (past_due) | **3 dias** (`graceUntil`) |
| Periodicidade | **Mensal e anual** (dois planos por tier) |
| Meio de pagamento | Cartão de crédito (recorrente), BRL |
| Cancelamento | Ao fim do período pago (`cancelAtPeriodEnd = true`) |
| Ativação | Somente por webhook validado / reconciliação (nunca pelo redirect) |

### Princípio de arquitetura

A camada de domínio **não** depende do SDK/HTTP do Asaas. O único módulo autorizado a falar com o Asaas é o adapter `AsaasPaymentProvider`, atrás da interface `PaymentProvider` (doc seção 12.4). Controllers, guards e serviços trabalham só com tipos internos.

---

## Prompt 0 — Pré-requisitos externos (não-código)

Não são executáveis por mim, mas **bloqueiam produção**. Registrar status antes de fechar o épico (doc Fases 1, 6, 9, 10, 11):

- Contratar e homologar conta **Asaas**; obter `ASAAS_API_KEY` (sandbox + produção) e token de webhook.
- Confirmar formalmente: taxas de cartão recorrente, prazo de recebimento, política de chargeback, retentativa de cobranças recusadas, fluxo de atualização de cartão, limites de API, DPA/suboperadores.
- Definir preços finais dos planos (este plano usa placeholders no seed).
- Jurídico/LGPD: aviso de privacidade, termos de assinatura, DPA com Asaas, bases legais, política de retenção, fluxo de direitos do titular, plano de resposta a incidentes.
- PCI DSS: confirmar SAQ aplicável ao Checkout Asaas com adquirente/assessor.
- Fiscal: definir emissão de NFS-e (recibo do PSP não substitui nota).
- Definir quem pode fazer alterações manuais de assinatura (RBAC admin + MFA).

**Critério:** itens acima documentados/contratados. O código pode ser desenvolvido em paralelo usando sandbox e placeholders.

---

## Prompt 1 — Fundação de domínio: Prisma + tipos compartilhados

**Objetivo:** modelar planos, assinaturas, pagamentos, eventos de webhook e auditoria no banco, sem nenhuma lógica de PSP.

**Arquivos:**
- [apps/api/prisma/schema.prisma](../apps/api/prisma/schema.prisma) — novos enums e models; relação em `User`.
- `apps/api/prisma/migrations/` — nova migration.
- [apps/api/prisma/seed.ts](../apps/api/prisma/seed.ts) (ou equivalente do `db:seed`) — seed dos planos.
- `packages/shared/src/` — enums e tipos de billing (espelhar enums do Prisma, ex. em `packages/shared/src/enums` e schemas Zod em `packages/shared/src/schemas`).

**Detalhes:**
- Models conforme doc seção 4: `Plan`, `Subscription`, `Payment`, `PaymentWebhookEvent`, `SubscriptionAudit`. Seguir convenção `@map("snake_case")` já usada no schema.
- Enums: `SubscriptionStatus` (`pending|trialing|active|past_due|canceled|unpaid|expired`), `PaymentStatus` (`pending|processing|paid|failed|refunded|partially_refunded|chargeback|canceled`), `BillingInterval` (`monthly|annual`), `PaymentMethodType` (`credit_card`).
- `Subscription` com `userId`, `planId`, `providerCustomerId`, `providerSubscriptionId`, `status`, `currentPeriodStart/End`, `trialEndsAt`, `graceUntil`, `cancelAtPeriodEnd`, `canceledAt`.
- `User` ganha `subscriptions Subscription[]` (e `providerCustomerId` se for reusado entre assinaturas — avaliar manter só na Subscription).
- `PaymentWebhookEvent.providerEventId` com `@unique` (idempotência).
- Seed: tier único do MVP em 2 planos (`mensal`/`anual`), `price` placeholder, `currency = BRL`, `isActive = true`, `features` como JSON.
- Migration via fluxo do projeto (`prisma migrate`), nunca editar migration aplicada.

**Done:** `prisma migrate` aplica; seed cria os planos; tipos compartilhados compilam e são importáveis em `apps/api`.

---

## Prompt 2 — Núcleo do domínio de billing (sem PSP)

**Objetivo:** módulo `billing` com a máquina de estados, regra de acesso e auditoria — testável isoladamente, sem rede.

**Arquivos (novos):** `apps/api/src/billing/` com `billing.module.ts`, serviços e `dto/`; registrar em [apps/api/src/app.module.ts](../apps/api/src/app.module.ts).

**Detalhes:**
- Interface `PaymentProvider` (doc seção 12.4) + tipos internos (`ProviderCustomer`, `CheckoutSession`, `ProviderSubscription`, `ProviderPayment`, `VerifiedPaymentEvent`, etc.). Definir token de injeção (`PAYMENT_PROVIDER`).
- `SubscriptionStateService`: transições válidas da máquina de estados; rejeitar transições inválidas; computar `currentPeriodEnd`, `trialEndsAt` (30d), `graceUntil` (3d).
- `SubscriptionAccessService.canUseProduct(userId)` (doc seção 5): libera se `active`, `trialing` (trial válido) ou `past_due` dentro de `graceUntil`. Retorno tipado reutilizável por API e canal interno.
- `SubscriptionAuditService`: registra transições (estado anterior/posterior, origem, ator) na tabela de auditoria.
- **Testes unitários** (doc seção 14): máquina de estados, cálculo de acesso, grace period, cancelamento programado.

**Done:** criar/consultar planos e assinaturas no banco; transições inválidas rejeitadas; domínio não importa nada do Asaas; testes unitários passando.

---

## Prompt 3 — Adapter Asaas + configuração

**Objetivo:** implementar `AsaasPaymentProvider` (único ponto que conhece o Asaas).

**Arquivos:** `apps/api/src/billing/providers/asaas/`; `apps/api/.env.example` ([apps/api/.env.example](../apps/api/.env.example)); ConfigModule já é global.

**Detalhes:**
- Cliente HTTP com `ASAAS_API_URL`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`; timeout e retry seguro (idempotente); sandbox e produção separados; nunca logar segredos.
- Implementar todos os métodos da interface: `createCustomer`, `createCheckout` (assinatura recorrente por cartão), `createPaymentMethodUpdateSession`, `cancelSubscription`, `getSubscription`, `listSubscriptionPayments`, `refundPayment`, `verifyWebhook` (valida assinatura sobre o **corpo bruto**).
- Mapear tipos do Asaas → tipos internos (nenhum tipo do Asaas vaza para fora do adapter).
- Bind do provider ao token `PAYMENT_PROVIDER` no `billing.module.ts`.
- Referências: docs do Asaas (assinaturas, checkout recorrente, webhooks, PCI).

**Done:** adapter implementa a interface; chamadas básicas (criar cliente, criar checkout) funcionam no sandbox; nenhum dado de cartão trafega pelo backend.

---

## Prompt 4 — Endpoints de billing (controllers)

**Objetivo:** expor billing ao frontend; estes endpoints permanecem acessíveis **sem** assinatura ativa (doc seção 5).

**Arquivos:** `apps/api/src/billing/billing.controller.ts` + DTOs.

**Endpoints (protegidos por `JwtAuthGuard`, padrão `@ApiCookieAuth`):**
- `GET /billing/plans` — lista planos ativos.
- `GET /billing/subscription` — estado da assinatura do usuário (status, plano, próxima cobrança, cancelamento programado, grace).
- `POST /billing/checkout` — cria/recupera cliente no Asaas e abre checkout recorrente; retorna URL. **Não ativa** a assinatura.
- `POST /billing/payment-method` — sessão segura de atualização de cartão (fluxo Asaas).
- `POST /billing/cancel` — marca `cancelAtPeriodEnd = true`; chama `cancelSubscription` no Asaas conforme política.

**Done:** usuário autenticado lista planos, inicia checkout e consulta/cancela assinatura; redirect do checkout não ativa conta.

---

## Prompt 5 — Webhook + processamento assíncrono idempotente

**Objetivo:** webhook como fonte primária de verdade do estado comercial (doc seção 7).

**Arquivos:** rota de webhook no `billing.controller.ts` (ou controller dedicado, **sem** `JwtAuthGuard`, com acesso ao raw body); worker/fila; mapper de eventos.

**Detalhes:**
- Garantir **raw body** para validação de assinatura (configurar no [apps/api/src/main.ts](../apps/api/src/main.ts) sem quebrar o `ValidationPipe`/`cookie-parser` existentes).
- `verifyWebhook` (via adapter); rejeitar assinaturas inválidas; validar timestamp se houver.
- Persistir `PaymentWebhookEvent` com `providerEventId` **antes** de processar; suportar duplicados e fora de ordem; responder rápido ao Asaas.
- Processamento assíncrono (fila — avaliar `@nestjs/bull`/Redis já presente no agente, ou fila in-process no MVP); retry com backoff; DLQ; histórico de tentativas; payload sanitizado (sem dados sensíveis).
- Mapear eventos → transições via `SubscriptionStateService`; para eventos críticos, confirmar com `getSubscription` antes de conceder/revogar acesso.
- **Testes** (doc seção 14): mapeamento de eventos, sanitização, idempotência, webhook autenticado.

**Done:** pagamento aprovado ativa assinatura; evento duplicado não duplica efeito; falha reprocessável; pagamento recusado não concede acesso.

---

## Prompt 6 — Reconciliação periódica

**Objetivo:** segunda linha de defesa contra divergências (doc seção 7).

**Arquivos:** `apps/api/src/billing/reconciliation.service.ts` (job agendado — `@nestjs/schedule`).

**Detalhes:** selecionar assinaturas recentemente alteradas/inconsistentes → consultar estado real no Asaas → comparar → corrigir de forma auditável (via `SubscriptionAuditService`) → emitir alerta operacional.

**Done:** divergências banco↔Asaas detectadas e corrigidas de forma auditável.

---

## Prompt 7 — Controle de acesso na API

**Objetivo:** centralizar a regra de assinatura na API (doc seção 5, Fase 4).

**Arquivos:** `apps/api/src/billing/guards/active-subscription.guard.ts`; decorator `@AllowWithoutSubscription()`; aplicar nos módulos de negócio e no `internal`.

**Detalhes:**
- `ActiveSubscriptionGuard` usa `SubscriptionAccessService.canUseProduct(userId)`.
- Decorator (metadata via `Reflector`) para liberar rotas permitidas sem assinatura: login/cadastro/refresh/logout, `/billing/*`, exportação/exclusão de dados, suporte.
- Aplicar o guard em: `accounts`, `categories`, `contacts`, `dashboard`, `transactions` (controllers em [apps/api/src/](../apps/api/src/)) — em conjunto com o `JwtAuthGuard` existente.
- **Endpoints internos** ([internal.controller.ts](../apps/api/src/internal/controllers/internal.controller.ts)): após resolver `userId`, validar assinatura antes de listar contas/categorias e criar lançamentos via IA; nunca aceitar `userId` arbitrário sem validar vínculo (doc seção 8.4).
- Erro padrão `403` `{ code: "SUBSCRIPTION_REQUIRED" }` (doc seção 5); inadimplente em grace continua liberado.
- **Testes**: aplicação do guard, usuário sem assinatura na API, manipulação de `userId`.

**Done:** sem assinatura → bloqueado em dados de negócio (web e API direta); billing/privacidade seguem acessíveis; frontend não é a única camada.

---

## Prompt 8 — Controle de acesso no canal WhatsApp/IA

**Objetivo:** não gastar com IA para contas sem acesso (doc seção 5, Fase 4).

**Arquivos (Python):** [apps/ai-agent/src/services/message_processor.py](../apps/ai-agent/src/services/message_processor.py), [apps/ai-agent/src/services/media_processor.py](../apps/ai-agent/src/services/media_processor.py), [apps/ai-agent/src/services/api_client.py](../apps/ai-agent/src/services/api_client.py); novo endpoint interno na API.

**Detalhes:**
- Novo endpoint interno (ex. `GET /internal/users/{userId}/subscription-access` ou incluir no resolve do contato) protegido por `InternalApiKeyGuard`, retornando `canUseProduct`.
- Checar assinatura **logo após resolver o contato** e **antes** de qualquer operação paga:
  - Texto: em `process_buffered_message`, antes de `intent_classifier.classify`.
  - Áudio: em `media_processor`, antes de `transcription_service.transcribe`.
  - Imagem: antes de `classify_image` (Vision).
- Sem acesso → responder mensagem orientando regularizar (link de billing), sem expor dados financeiros.

**Done:** WhatsApp não cria lançamentos nem consome LLM/STT/Vision sem assinatura; bloqueio consistente com web/API.

---

## Prompt 9 — Frontend (Next.js)

**Objetivo:** contratação, gestão e estados de assinatura (doc Fase 5), mobile-first.

**Arquivos:** rotas em [apps/web/src/app/](../apps/web/src/app/) (ex. `app/app/conta/assinatura`, páginas de planos e retorno/cancelamento do checkout); [apps/web/src/contexts/auth-context.tsx](../apps/web/src/contexts/auth-context.tsx); [apps/web/src/lib/auth.ts](../apps/web/src/lib/auth.ts); [apps/web/src/lib/api-client.ts](../apps/web/src/lib/api-client.ts); [apps/web/src/middleware.ts](../apps/web/src/middleware.ts).

**Detalhes:**
- Página de planos (cards mensal/anual, valores em `R$` com `toLocaleString('pt-BR')`).
- Início do checkout (redirect Asaas) + páginas de retorno/sucesso e cancelamento — **retorno não ativa a conta**; o estado vem do backend.
- Tela "Minha assinatura": plano, status, próxima cobrança, cancelamento programado; atualizar cartão (fluxo hospedado Asaas); cancelar; avisos de pagamento recusado e grace period.
- `api-client.ts`: tratar `403 SUBSCRIPTION_REQUIRED` redirecionando para billing (reusar o `ApiClientError` existente).
- `auth-context`/`User`: incluir estado de acesso à assinatura.
- Avaliar usar `middleware.ts` para gating de rota server-side (hoje no-op), mantendo a API como camada de verdade.
- Seguir padrões existentes (shadcn/ui, react-hook-form + Zod, `toast`), **mobile first**, listas 10/página.

**Done:** usuário contrata, consulta e cancela; retorno visual não ativa antes do backend; estados de loading/falha/inadimplência tratados.

---

## Prompt 10 — Segurança e privacidade

**Objetivo:** controles mínimos para produção (doc seções 8, 10, Fase 6).

**Itens de código:**
- CSRF para operações autenticadas por cookie (atenção ao `SameSite=None` em produção — doc seção 8.3).
- Rate limiting em login, cadastro, checkout e billing (`@nestjs/throttler`).
- Helmet + CSP + headers de segurança no [main.ts](../apps/api/src/main.ts); proteger/desabilitar Swagger em produção.
- Rotação/revogação de refresh tokens; cookies `Secure`/`HttpOnly`/`SameSite` revisados.
- Revisar logs (API + agente) para garantir ausência de segredos/dados de cartão.
- **Verificação de telefone por OTP** (doc seção 8.5): hoje o cadastro marca WhatsApp como verificado sem confirmação ([apps/web/src/app/(auth)/cadastro/page.tsx](../apps/web/src/app/(auth)/cadastro/page.tsx) + registro na API). Implementar fluxo de OTP antes de usar WhatsApp para ações financeiras.
- Rotação da `INTERNAL_API_KEY` e comparação segura (doc seção 8.4).
- Exportação e exclusão de dados (direitos do titular — doc seção 10.4); política de retenção/descarte.
- Scanners no CI: SAST, análise de dependências, secret scanning.

**Itens não-código (documentar — doc Prompt 0):** plano de resposta a incidentes, responsabilidades com o PSP, evidência da análise PCI aplicável.

**Done:** nenhum dado de cartão no backend; logs sem segredos; OTP de telefone ativo; fluxos de direitos do titular definidos; incidentes documentados.

> **Status (implementado):** rate limiting (`@nestjs/throttler`), Helmet + headers + Swagger fora de produção, **CSRF double-submit** (guard global + cookie `csrf_token` + header `x-csrf-token` no frontend), comparação **timing-safe** da `INTERNAL_API_KEY`, revisão de cookies e revisão de logs (sem segredos/cartão).
>
> **Deferido para os Prompts 12–16** (cada um altera fluxos sensíveis — auth/migrations/CI — e merece escopo e testes próprios): rotação/revogação de refresh token, OTP de telefone, exportação/exclusão de dados (LGPD), scanners de CI, e os itens não-código (incidentes, PSP, PCI).

---

## Prompt 11 — Testes e rollout

**Objetivo:** cobrir cenários críticos e liberar com segurança (doc Fases 7, seção 14).

**Cenários obrigatórios:** checkout concluído/abandonado, pagamento recusado, webhook inválido/duplicado/fora de ordem, renovação aprovada/recusada, grace period, expiração, cancelamento ao fim do período, cancelamento imediato, reembolso, chargeback, divergência banco↔PSP, indisponibilidade do PSP, usuário sem assinatura (web/API/WhatsApp), acesso a dados de outro usuário.

**Camadas:** unitários (estado/acesso/grace/idempotência/sanitização), integração (migrations, endpoints billing, webhook autenticado, fila, reconciliação, guard), e2e (cadastro→ativação, inadimplência→bloqueio→reativação, cancelamento mantendo acesso, bloqueio consistente web/API/WhatsApp), segurança (CSRF, replay de webhook, manipulação de `userId`, rate limiting, enumeração).

**Rollout:** mocks locais → sandbox Asaas → staging → testes internos → beta → produção com **feature flag** → ativação progressiva da obrigatoriedade. Monitorar conversão, aprovados/recusados, `past_due`, falhas de webhook, tamanho da DLQ, divergências, chargebacks, cancelamentos, latência do PSP, custo de IA bloqueado.

**Done:** cenários críticos automatizados; rollout com flag; monitoramento operacional. Atende a Definition of Done (doc seção 17).

---

## Prompts deferidos do Prompt 10 (executar ao final de tudo)

Itens de segurança/privacidade desmembrados do Prompt 10 por alterarem fluxos sensíveis (auth, migrations, CI). Executar **após** o Prompt 11, em sequência independente.

### Prompt 12 — Rotação e revogação de refresh token

**Objetivo:** invalidar refresh tokens no logout/refresh e em caso de comprometimento (doc seção 8.3).

**Detalhes:**
- Persistir refresh tokens (model Prisma + migration), ex. `RefreshToken` com `userId`, `tokenHash`, `expiresAt`, `revokedAt`, `replacedById`.
- No refresh: validar o token contra o store, **rotacionar** (emitir novo, revogar o anterior) e detectar reuso (revogar a família em caso de replay).
- No logout: revogar o refresh token atual.
- Ajustar `auth.service`/`auth.controller` e a strategy de refresh.
- **Testes:** rotação, revogação no logout, replay de token revogado.

**Done:** refresh token rotacionado a cada uso; logout revoga; replay detectado e bloqueado.

### Prompt 13 — Verificação de telefone por OTP

**Objetivo:** confirmar posse do número antes de usar o WhatsApp para ações financeiras (doc seção 8.5). **Depende do canal de envio (Prompt 0).**

**Detalhes:**
- Hoje o cadastro marca `whatsappContact.isVerified = true` sem confirmação ([apps/web/src/app/(auth)/cadastro/page.tsx](../apps/web/src/app/(auth)/cadastro/page.tsx) + registro na API).
- Gerar OTP (curto, com expiração e rate limit), armazenar hash, enviar pelo canal (WhatsApp/SMS), endpoint de verificação; só então `isVerified = true`.
- Frontend: passo de confirmação no cadastro/edição de telefone.
- **Testes:** geração/expiração/limite de OTP, verificação correta/incorreta.

**Done:** WhatsApp só é usado para ações financeiras após verificação por OTP.

### Prompt 14 — Exportação e exclusão de dados (LGPD)

**Objetivo:** suportar direitos do titular (doc seção 10.4).

**Detalhes:**
- Endpoint de **exportação** (agrega dados pessoais e financeiros do usuário em formato portável).
- Endpoint de **exclusão/anonimização** (cascata respeitando retenção legal de registros fiscais/auditoria; informar exceções ao titular).
- Marcar essas rotas com `@AllowWithoutSubscription()` (acessíveis sem assinatura — doc seção 5).
- Política de retenção/descarte documentada.
- Frontend: ação na área "Minha Conta".
- **Testes:** exportação completa, exclusão com isolamento por `userId`, retenção de registros obrigatórios.

**Done:** titular consegue exportar e excluir/anonimizar seus dados; exceções legais preservadas e comunicadas.

### Prompt 15 — Scanners de segurança no CI

**Objetivo:** SAST, análise de dependências e secret scanning no pipeline (doc seção 8.6).

**Detalhes:**
- Configurar pipeline (ex. GitHub Actions): SAST, auditoria de dependências (Node + Python) e secret scanning; falhar o build em achados críticos.
- Rodar lint e suítes de teste (corrigir também o script `pnpm lint`, hoje quebrado pelo glob/ignore).

**Done:** CI executa scanners e barra achados críticos antes do merge.

### Prompt 16 — Documentação não-código (compliance)

**Objetivo:** fechar itens documentais que bloqueiam produção (doc seções 9, 10; Prompt 0).

**Detalhes:** plano de resposta a incidentes; responsabilidades com o PSP (DPA/suboperadores); evidência da análise PCI aplicável ao Checkout Asaas; bases legais, aviso de privacidade, termos de assinatura, política de retenção.

**Done:** documentos aprovados/arquivados; enquadramento PCI validado.

---

## Verificação end-to-end

Após os prompts de código, validar localmente:

1. `pnpm db:up` + `pnpm --filter @financial-vellun/api exec prisma migrate deploy` + `pnpm --filter @financial-vellun/api db:seed` — schema e planos no banco.
2. `pnpm dev` (api+web+agent). Swagger em `http://localhost:3001/api/docs`.
3. Fluxo feliz no **sandbox Asaas**: cadastro → `GET /billing/plans` → `POST /billing/checkout` → pagar no sandbox → webhook → assinatura `active`.
4. Webhook duplicado e inválido (curl com assinatura errada/repetida) — confirmar idempotência e rejeição.
5. Sem assinatura: chamar endpoint de negócio na API (`403 SUBSCRIPTION_REQUIRED`), tentar pelo WhatsApp (mensagem de bloqueio, **sem** chamada ao LLM), e na web (redirect para billing).
6. Cancelar (`POST /billing/cancel`) → acesso mantido até `currentPeriodEnd`.
7. `pnpm lint` e suíte de testes (`apps/api` Jest, `apps/ai-agent` pytest).

## Sequenciamento e dependências

```
0 (externo) ─┐
1 (Prisma) ──► 2 (domínio) ──► 3 (Asaas) ──► 4 (endpoints) ──► 5 (webhook) ──► 6 (reconciliação)
                          └────────────────► 7 (guard API) ──► 8 (WhatsApp/IA)
4,7,8 ──► 9 (frontend)
tudo ──► 10 (segurança, núcleo) ──► 11 (testes/rollout)
11 ──► 12 (refresh rotation) ──► 13 (OTP) ──► 14 (LGPD export/delete) ──► 15 (CI scanners) ──► 16 (docs)
```

Prompts 1→6 são backend de billing em sequência estrita. 7 depende de 2 (não de 5). 9 depende de 4/7/8. 10 (núcleo) e 11 fecham o MVP; 12–16 são os itens de segurança/privacidade deferidos do Prompt 10, executados ao final.
