# Plano — correções do módulo de billing

## Contexto

A análise em `docs/analise-billing-2026-10-12.md` encontrou, no módulo `apps/api/src/billing/`:

- duas falhas que devolvem acesso a quem não pagou (2.1 e 2.2);
- processamento de webhook em até seis escritas sem transação, com handlers que não são idempotentes (5.2, 5.3, 6);
- eventos que se perdem ou são dados como resolvidos sem efeito (2.4/5.1, 5.4);
- escritas no Asaas e no banco em ordem insegura no cancelamento e no checkout (5.5, 5.6, 2.3);
- eventos do Asaas que fazem falta e hoje são ignorados (3.2);
- acoplamentos que encarecem uma troca de gateway (1.2).

O plano cobre todos os pontos do documento, em seis entregas. Cada entrega é um PR independente, na ordem abaixo. A referência entre parênteses é a seção do documento de análise.

**Ideia central das entregas 1 e 2:** o webhook deixa de ser a fonte da verdade e vira um aviso. A cada evento de cobrança, o processador consulta a cobrança no gateway e aplica o efeito na assinatura **somente quando o status local daquele pagamento muda**, dentro de uma única transação com a linha da assinatura travada. Isso resolve de uma vez o `PAYMENT_RECEIVED` tardio, o payload forjado, a ordem invertida por retry e os efeitos repetidos em reprocessamento.

## Decisões

Confirmadas pelo Bruno em 12/10/2026.

1. **Estorno integral revoga o acesso** e cancela a assinatura no gateway; estorno parcial só é registrado. (2.7)
2. **Inadimplente regulariza com um novo checkout.** Quando a nova assinatura é ativada, as assinaturas antigas do mesmo usuário são canceladas no gateway. A atualização de cartão hospedada continua sem implementação. (2.3)
3. **Independência de gateway em versão enxuta:** coluna `provider`, status tipados, erro neutro e regra de endereço fora do domínio. Sem registro de múltiplos providers nem rota por provider enquanto não houver um segundo gateway escolhido. (1.2)

---

## Andamento

| Entrega | Situação                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------ |
| 0       | Feita em 12/10/2026. Resultado na seção 9 de `docs/analise-billing-2026-10-12.md`.               |
| 1       | Implementada no branch `fix/billing-acesso-sem-pagamento`. Falta a verificação com webhook real. |
| 2 a 5   | Pendentes.                                                                                       |

Desvios da entrega 1 em relação ao texto abaixo, todos motivados pelo sandbox:

- `currentPeriodEnd` é derivado da cobrança paga (`vencimento + ciclo`), não de `getSubscription`. O `nextDueDate` do Asaas fica um ou dois ciclos à frente.
- A assinatura é localizada pelos vínculos da cobrança consultada no PSP, não pelos do payload.
- Cobrança paga cujo período já terminou não concede acesso. É uma segunda barreira contra o `PAYMENT_RECEIVED` tardio, para o caso de o `PAYMENT_CONFIRMED` nunca ter sido registrado.
- Assinatura já `past_due` não recebe novo grace quando outra cobrança vence.
- A cobrança é registrada **depois** do efeito na assinatura. Sem a transação da entrega 2, gravá-la antes faria um retry encontrá-la "já tratada".
- `cancelSubscription` já trata 404 como sucesso (estava na entrega 3), porque o estorno integral passou a chamá-lo.
- `ProviderSubscription.currentPeriodEnd` foi renomeado para `nextDueAt`.
- A regra compartilhada entre webhook e reconciliação ficou num serviço novo, `services/charge-sync.service.ts`.

Ajustes feitos depois da revisão de código da entrega 1:

- **Chargeback** vale para qualquer cobrança, não só a mais recente, e enquanto houver uma em disputa nenhum pagamento devolve o acesso.
- **Estorno** só cancela quando concluído (`REFUNDED`). Pedido e em andamento viram `processing`. O cancelamento no PSP usa a assinatura da cobrança quando a linha local ainda não tem vínculo.
- **Correlação por cliente** só casa com linha local ainda sem `providerSubscriptionId`. Cobrança avulsa, ou de outra assinatura do mesmo cliente, não casa com nada.
- **Período** não transborda o mês (31/01 + 1 mês = 28/02).
- **Reconciliação** relê o estado local depois das consultas ao PSP, avança o cursor do lote numa escrita só e move para `past_due` a assinatura em dia cujo período pago terminou sem o PSP ter gerado nova cobrança.
- O índice em `last_reconciled_at` foi retirado: o Postgres não o usaria para `NULLS FIRST`.

Pontos para o deploy da entrega 1:

- Na primeira reconciliação, quem está `active` com a última cobrança vencida vai para `past_due` e, se o vencimento tem mais de 3 dias, perde o acesso na hora.
- A regra de estorno **não é retroativa** (decisão do Bruno em 12/10/2026). O estorno só revoga o acesso quando o aviso chega pelo webhook. A reconciliação não cancela: ao encontrar uma assinatura com a última cobrança vencida estornada, registra o pagamento, emite um alerta, uma vez, e conta como divergência manual.
- O `currentPeriodEnd` de todas as assinaturas ativas é recalculado, com um alerta por assinatura.

Fica para a entrega 2: a janela de milissegundos entre a releitura do estado local e a escrita, que só a trava por assinatura fecha.

## Entrega 0 — Reprodução no sandbox do Asaas

Pré-requisito da entrega 1. Sem código de produção. Precisa das credenciais de sandbox do Bruno.

Confirmar e registrar o resultado numa seção nova do documento de análise:

| #   | Pergunta                                                                                              | Afeta              |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------ |
| a   | Assinatura com cobrança vencida continua `ACTIVE`?                                                    | 2.1                |
| b   | `PAYMENT_RECEIVED` chega depois de `PAYMENT_CONFIRMED` para a mesma cobrança de cartão?               | 2.2                |
| c   | `GET /subscriptions/{id}` de assinatura removida responde 200 com `deleted: true` ou 404?             | 2.2, reconciliação |
| d   | Segundo `DELETE /subscriptions/{id}` responde qual status?                                            | 2.7                |
| e   | O payload de cobrança e o de `SUBSCRIPTION_CREATED` trazem `checkoutSession`?                         | entrega 3          |
| f   | `GET /subscriptions/{id}/payments`: ordem, paginação padrão, e se inclui cobranças futuras já geradas | 2.1                |
| g   | `GET /customers?externalReference=` devolve o cliente criado com aquele `externalReference`?          | 5.6                |

Se (a) ou (b) não se confirmarem, o achado correspondente cai de gravidade, mas a correção continua válida.

---

## Entrega 1 — Acesso sem pagamento (2.1, 2.2, 2.5, 2.6)

### Contrato do provider

`providers/payment-provider.interface.ts`:

- Novo método `getPayment(providerPaymentId): Promise<ProviderPayment>`.
- `ProviderPayment` ganha `providerSubscriptionId`, `providerCustomerId` e `providerCheckoutId` (todos `string | null`).

`providers/asaas/`: implementar com `GET /payments/{id}`; `mapPayment` em `asaas.mapper.ts` passa a preencher os novos campos (`subscription`, `customer`, `checkoutSession`) e trata `deleted: true` como `canceled`.

### Processador: sincronizar pela cobrança

`webhook/webhook.processor.ts` — os handlers `handleSuccess`, `handleFailure`, `handleChargeback` e o registro de estorno são substituídos por um único `syncPayment(sub, providerPaymentId)`:

1. `remote = provider.getPayment(id)`. O status do payload deixa de ser usado. (2.5)
2. Lê o `Payment` local por `providerPaymentId` e guarda o status anterior.
3. Grava o `Payment` com o status remoto (isso também corrige `partially_refunded`, 3.3).
4. **Se o status local não mudou, termina aqui.** É o que barra o `PAYMENT_RECEIVED` tardio: a cobrança já estava `paid`. (2.2)
5. Se existe outra cobrança da mesma assinatura com `dueAt` maior, termina aqui: só a cobrança mais recente decide o estado da assinatura. (6, ordem invertida)
6. Aplica o efeito conforme o novo status:

| Novo status da cobrança                                   | Efeito na assinatura                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `paid`                                                    | `active`; `currentPeriodStart = paidAt ?? dueAt`; `currentPeriodEnd` vindo de `getSubscription`; `graceUntil = null`            |
| `failed`                                                  | com acesso (`active`/`trialing`/`past_due`): `past_due` com `graceUntil = dueAt + GRACE_DAYS`; sem acesso (`pending`): `unpaid` |
| `chargeback`                                              | `unpaid`                                                                                                                        |
| `refunded`                                                | cancela no gateway e vai para `canceled` (decisão 1)                                                                            |
| `partially_refunded`, `pending`, `processing`, `canceled` | nenhum                                                                                                                          |

As datas passam a derivar da cobrança, não de `new Date()`. `computeGraceUntil(from)` em `services/subscription-state.service.ts` já aceita a data de origem.

### Reconciliação

`reconciliation.service.ts`:

- `targetFromRemote`: assinatura remota `active` **deixa de promover** `past_due`, `unpaid` e `pending` para `active`. Para decidir, usa `listSubscriptionPayments` (já existe na interface, hoje sem uso): pega a cobrança mais recente com vencimento até hoje e aplica a mesma tabela acima. (2.1)
- A tabela de efeitos vira uma função pura compartilhada entre processador e reconciliação, em `services/subscription-state.service.ts`.
- Rodízio do lote: nova coluna `Subscription.lastReconciledAt`; ordenar por ela (`nulls: 'first'`) e atualizá-la a cada assinatura verificada, mesmo quando consistente. (2.6)

### Schema

Migration `<data>_billing_reconciliation_cursor`: `subscriptions.last_reconciled_at TIMESTAMP NULL`.

### Testes

- `webhook.processor.spec.ts`: `RECEIVED` após `CONFIRMED` não transiciona; `RECEIVED` tardio com assinatura `past_due` ou `canceled` não reativa; payload `paid` com remoto `pending` não ativa; cobrança antiga não rebaixa nem promove.
- `reconciliation.service.spec.ts`: local `past_due` + remoto `active` + última cobrança vencida fica `past_due`; local `unpaid` + remoto `active` fica `unpaid`; local `active` + última cobrança vencida vira `past_due`; o lote avança entre execuções.
- `asaas.mapper.spec.ts` e `asaas-payment.provider.spec.ts`: `getPayment` e novos campos.

---

## Entrega 2 — Atomicidade e durabilidade do webhook (2.4, 5.1, 5.2, 5.3, 5.4, 6)

### Uma transação por evento

Chamadas ao gateway (`getPayment`, `getSubscription`) acontecem **antes** da transação. Depois, em um único `prisma.$transaction`:

1. `lockSubscription(tx, id)` — novo helper em `common/db.ts`, no molde de `lockTransaction` e `lockCreditCard` que já existem ali. Serializa os eventos da mesma assinatura.
2. Relê a assinatura e o `Payment` já sob a trava.
3. Upsert do pagamento, transição, auditoria, `linkSubscription` e `markProcessed`.

Para isso, estes métodos ganham um parâmetro opcional `db: Db = this.prisma` (tipo `Db` de `common/db.ts`, mesmo padrão de `OpsAuditService.record(input, tx)`):

- `SubscriptionService.transitionTo`
- `SubscriptionAuditService.record`
- `PaymentService.upsertFromProvider`
- `WebhookEventService.markProcessed` e `linkSubscription`

`transitionTo` fora de transação passa a usar `updateMany` com `status` no `where` e conferir `count`, para não valer a última escrita.

### Correções pontuais

- **Evento órfão em `received`:** `webhook-retry.service.ts` passa a varrer também `received` com `receivedAt` há mais de 60 segundos. `markProcessing` já aceita esse status. Corrigir o comentário de `unrecorded` em `webhook.processor.ts`, que afirma que a linha fica em `processing`.
- **Métrica:** em `WebhookEventService.markProcessed`, incrementar `processed` depois da gravação. Dentro da transação, incrementar só após o commit.
- **Evento de cobrança sem assinatura local:** em `apply`, quando a intenção é de cobrança e `locate` não encontra nada, lançar um erro de domínio novo (`UncorrelatedPaymentEventError` em `billing.errors.ts`). O evento segue o retry normal e termina em `exhausted`, visível no painel de operações. `subscription_canceled` sem assinatura local continua sendo processado sem erro.

### Testes

- `webhook.processor.spec.ts`: falha na auditoria desfaz a transição; reprocessar o mesmo evento não altera `graceUntil` nem `currentPeriodStart`; cobrança paga sem assinatura local termina em falha, não em `processed`.
- `webhook-retry.service.spec.ts`: `received` antigo é reivindicado; `received` recente não.
- Teste de integração com Postgres real para a trava: dois eventos da mesma assinatura em paralelo produzem o estado final correto e duas auditorias coerentes.

---

## Entrega 3 — Checkout e cancelamento (2.3, 2.7, 5.5, 5.6, 3.2 em parte)

Substitui `plan/asaas-checkout-expiration-handling-plan.md`. A correlação passa a ser por `checkout.id` e `payment.checkoutSession`, não por `externalReference` no payload do webhook, que a documentação não lista. (3.3)

### Schema

Migration `<data>_billing_checkout_correlation` em `subscriptions`:

- `provider_checkout_id TEXT NULL UNIQUE`
- `checkout_expires_at TIMESTAMP NULL`

### Checkout (`billing.service.ts`, `services/subscription.service.ts`)

Nova ordem em `createCheckout`:

1. Valida plano e acesso. O bloqueio "já possui assinatura ativa" passa a valer só para `active` e `trialing`; `past_due` em grace pode abrir checkout para regularizar (decisão 2).
2. Cria ou reaproveita a assinatura local `pending` **antes** de falar com o gateway.
3. Garante o cliente no gateway e grava `providerCustomerId` na linha `pending` imediatamente. O adapter consulta `GET /customers?externalReference={userId}` antes de criar, então uma repetição reaproveita o cliente. (5.6)
4. Cria o checkout com `externalReference = subscription.id`; grava `providerCheckoutId` e `checkoutExpiresAt`. `CheckoutSession` ganha `expiresAt`.

Plano gratuito: o atalho de R$ 0,00 só funciona com `NODE_ENV !== 'production'`. Em produção responde "Plano não encontrado". (2.7)

### Ativação

No efeito `paid` de `syncPayment`:

- **Valor pago x plano:** se `remote.amount` difere de `plan.price`, procura o plano ativo com aquele preço e troca o `planId` na mesma transação, com auditoria. Se não achar, falha o evento (vai para o painel). Pressupõe preços distintos entre planos ativos, o que vale hoje. (2.7)
- **Assinaturas antigas:** antes da transação, cancela no gateway as outras assinaturas do usuário que tenham `providerSubscriptionId` diferente e status fora de `canceled`/`expired`; dentro dela, marca essas linhas como `canceled` com ator `superseded`. (2.3)

### Novas intenções

`WebhookIntent` ganha `checkout_expired` e `subscription_created`. `NormalizedWebhookEvent` ganha `providerCheckoutId`.

| Evento Asaas                            | Intenção               | Efeito                                                                            |
| --------------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `CHECKOUT_EXPIRED`, `CHECKOUT_CANCELED` | `checkout_expired`     | `pending` com aquele `providerCheckoutId` vai para `expired`; outros status, nada |
| `SUBSCRIPTION_CREATED`                  | `subscription_created` | grava `providerSubscriptionId`; não concede acesso                                |

`locate` passa a buscar por `providerSubscriptionId`, depois `providerCheckoutId`, depois `providerCustomerId`.

Reconciliação: `pending` sem `providerSubscriptionId` e com `checkoutExpiresAt` vencido há mais de 30 minutos vai para `expired`. Pagamento atrasado ainda ativa, porque `expired → active` é permitido.

### Cancelamento (`billing.service.ts`, adapter)

- Grava `cancelAtPeriodEnd = true` primeiro (`scheduleCancellation`), depois chama o gateway. Se o gateway falhar, desfaz a flag, registra auditoria `cancel_reverted` e devolve o erro. (5.5)
- Se já está com `cancelAtPeriodEnd`, devolve o estado atual sem chamar o gateway.
- `AsaasPaymentProvider.cancelSubscription` trata 404 como sucesso. (2.7)

### Web (`apps/web/src/app/app/conta/assinatura/page.tsx`, `lib/billing.ts`)

Mobile first, como manda o `CLAUDE.md`.

- `expired`: aviso de que o checkout expirou e lista de planos para tentar de novo.
- `past_due` e `unpaid`: o botão "Atualizar cartão" vira "Regularizar pagamento" e abre um novo checkout do plano atual. Remover `createPaymentMethodSession` da tela.

### Testes

`billing.service.spec.ts` (ordem das escritas, reversão do cancelamento, cancelamento repetido, plano gratuito em produção), `asaas-webhook.mapper.spec.ts` (novas intenções), `webhook.processor.spec.ts` (checkout expirado, troca de plano pelo valor, cancelamento das antigas), `reconciliation.service.spec.ts` (pendência vencida).

---

## Entrega 4 — Eventos restantes (3.2)

`providers/asaas/asaas-webhook.mapper.ts` e `webhook/webhook.processor.ts`:

| Evento Asaas                                                                                                              | Intenção                 | Efeito                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`, `PAYMENT_REPROVED_BY_RISK_ANALYSIS`                                                | `payment_refused` (nova) | registra a recusa; se a assinatura está `pending`, vai para `unpaid`, o que libera nova tentativa na tela; renovação continua esperando o `PAYMENT_OVERDUE` |
| `PAYMENT_DELETED`, `PAYMENT_RESTORED`, `PAYMENT_UPDATED`, `PAYMENT_RECEIVED_IN_CASH_UNDONE`, `PAYMENT_REFUND_IN_PROGRESS` | `payment_updated` (nova) | `syncPayment`, que espelha a cobrança e só mexe na assinatura pelas regras da entrega 1                                                                     |

`GET /billing/subscription` passa a devolver `lastPaymentFailure` (data e motivo genérico), e a tela de assinatura mostra "cartão recusado, tente novamente" quando houver.

Testes: `asaas-webhook.mapper.spec.ts` com a tabela completa de eventos, incluindo um teste que garante que evento desconhecido continua virando `ignore`.

---

## Entrega 5 — Independência do gateway (1.2)

Versão enxuta (decisão 3).

- **Coluna `provider`:** `TEXT NOT NULL DEFAULT 'asaas'` em `subscriptions`, `payments` e `payment_webhook_events`. As chaves únicas passam a ser compostas: `(provider, provider_event_id)`, `(provider, provider_subscription_id)`, `(provider, provider_payment_id)`, `(provider, provider_checkout_id)`. `PaymentProvider` ganha `readonly name: string`, gravado em toda linha nova.
- **Status tipados:** `ProviderSubscriptionStatus` e `ProviderPaymentStatus` como uniões em `payment-provider.interface.ts`; mappers e reconciliação passam a usá-las.
- **Erro neutro:** `providers/payment-provider.errors.ts` com `PaymentProviderError` e `kind` (`validation`, `not_found`, `unauthorized`, `unavailable`, `not_supported`). O adapter para de lançar exceções do NestJS e não deixa mais `AsaasApiError` escapar. `BillingService` e `BillingWebhookController` traduzem para HTTP.
- **Regra de endereço:** `PaymentProvider.requiredCustomerFields` declara o que o gateway exige. `assertBillingProfileComplete` em `billing.service.ts` valida a partir dessa lista e mantém a mensagem atual.
- **Cancelamento:** remover `cancelAtPeriodEnd` de `CancelSubscriptionInput`. O contrato documentado passa a ser "interrompe cobranças futuras"; manter o acesso até o fim do período é do domínio.
- **Bind:** `billing.module.ts` escolhe o adapter por `PAYMENT_PROVIDER` (padrão `asaas`) via `useFactory`. Documentar em `apps/api/.env.example`.

Fora do escopo, até existir um segundo gateway: registro de vários providers e rota `/billing/webhook/:provider`.

---

## Arquivos principais

- `apps/api/src/billing/webhook/webhook.processor.ts` — entregas 1, 2, 3, 4
- `apps/api/src/billing/reconciliation.service.ts` — entregas 1, 3
- `apps/api/src/billing/billing.service.ts` — entregas 3, 5
- `apps/api/src/billing/providers/payment-provider.interface.ts` — entregas 1, 3, 5
- `apps/api/src/billing/providers/asaas/*` — todas
- `apps/api/src/billing/services/{subscription,subscription-state,subscription-audit,payment}.service.ts` — entregas 1, 2
- `apps/api/src/billing/webhook/{webhook-event,webhook-retry}.service.ts` — entrega 2
- `apps/api/src/common/db.ts` — `lockSubscription`
- `apps/api/prisma/schema.prisma` + três migrations (entregas 1, 3, 5)
- `apps/web/src/app/app/conta/assinatura/page.tsx`, `apps/web/src/lib/billing.ts` — entregas 3, 4

Migrations só acrescentam colunas e índices; nenhuma remove tabela ou coluna.

## Verificação

Por entrega:

1. `pnpm --filter @financial-vellun/api test -- billing` e `pnpm lint`.
2. `pnpm --filter @financial-vellun/api exec prisma migrate deploy` num banco local, quando houver migration.
3. Fluxo no sandbox do Asaas, com `BILLING_CALLBACK_BASE_URL` apontando para um túnel público:
   - **Entrega 1:** pagar um checkout, deixar a renovação vencer, e conferir que a assinatura fica `past_due` depois de uma rodada de reconciliação e depois de reenviar um `PAYMENT_RECEIVED` da cobrança anterior.
   - **Entrega 2:** derrubar a API logo após o 200 do webhook e conferir que o evento `received` é processado na varredura seguinte.
   - **Entrega 3:** deixar um checkout expirar (tela volta a oferecer planos); cancelar duas vezes; regularizar um `past_due` e conferir no painel do Asaas que só restou uma assinatura.
   - **Entrega 4:** pagar com o cartão de teste que é recusado e conferir a mensagem na tela.
4. Telas da web conferidas em largura de celular, tablet e desktop com o roteiro de Puppeteer já usado no projeto, sem rodar `next build` com o `next dev` aberto.
