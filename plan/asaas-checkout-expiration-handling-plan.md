# Plano — Tratamento de Checkout Expirado e Correlação de Webhooks Asaas

## Summary

Implementar correlação robusta entre checkout Asaas, assinatura local e webhooks para evitar assinaturas presas em `pending` quando o usuário inicia o checkout e não conclui o pagamento.

O caso real foi o customer `cus_000008405508`: recebeu `CHECKOUT_CREATED` às 11:36 e `CHECKOUT_EXPIRED` às 12:36, sem `SUBSCRIPTION_CREATED` nem `PAYMENT_CONFIRMED`. A API respondeu `200`, mas o evento foi ignorado e a assinatura local permaneceu em "Pagamento em processamento".

Decisão principal: criar a assinatura local `pending` antes de abrir o checkout e enviar `externalReference = subscription.id` ao Asaas. Persistir `providerCheckoutId` e `checkoutExpiresAt` na assinatura para localizar e expirar corretamente pendências.

## Key Changes

### Modelo e contrato interno

- Adicionar em `Subscription`:
  - `providerCheckoutId String? @unique @map("provider_checkout_id")`
  - `checkoutExpiresAt DateTime? @map("checkout_expires_at")`
- Criar migration Prisma correspondente, sem alterar migrations antigas.
- Estender `CreateCheckoutInput` com:
  - `externalReference: string`
- Estender `NormalizedWebhookEvent` com:
  - `providerCheckoutId: string | null`
- Estender `WebhookIntent` com:
  - `checkout_expired`
  - opcionalmente `subscription_created`

### Fluxo de criação de checkout

- Alterar `BillingService.createCheckout` para:
  - validar plano, usuário e perfil de cobrança como hoje;
  - criar/reusar `providerCustomerId`;
  - criar ou atualizar assinatura local `pending` antes da chamada ao Asaas;
  - passar `externalReference = subscription.id` ao `provider.createCheckout`;
  - salvar `providerCheckoutId` e `checkoutExpiresAt` após retorno do Asaas;
  - retornar `checkoutUrl`.
- Ajustar `SubscriptionService.prepareCheckoutSubscription` para retornar a assinatura local e aceitar atualizações posteriores de checkout.
- Se a criação do checkout falhar depois da assinatura `pending` ter sido criada, marcar a assinatura como `expired` ou registrar auditoria de falha operacional; não deixar pendência sem checkout.

### Adapter e webhooks Asaas

- Em `AsaasPaymentProvider.createCheckout`, enviar `externalReference` no payload do checkout.
- Em tipos privados do Asaas, incluir `checkout.externalReference`, `checkout.id`, `checkout.customer` e `subscription.checkoutSession`.
- No mapper:
  - `CHECKOUT_EXPIRED` → `checkout_expired`, com checkout id, customer e externalReference;
  - `SUBSCRIPTION_CREATED` → `subscription_created`, preenchendo `providerSubscriptionId`, `providerCustomerId`, `providerCheckoutId`;
  - manter `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` como ativação real.
- No processador:
  - localizar primeiro por `externalReference`/`subscription.id`, depois por `providerCheckoutId`, depois por `providerSubscriptionId`, e só então por `providerCustomerId`;
  - `checkout_expired`: se assinatura ainda estiver `pending`, transicionar para `expired`; se já estiver `active`, ignorar;
  - `subscription_created`: preencher `providerSubscriptionId` quando a assinatura local ainda não tiver esse vínculo; não conceder acesso;
  - `payment_succeeded`: comportamento atual permanece, ativando somente após confirmação de pagamento.

### Reconciliação e UI

- Ajustar reconciliação para expirar pendências locais com `status=pending`, `providerSubscriptionId=null` e `checkoutExpiresAt < now`.
- Na tela de assinatura:
  - `pending`: manter estado de aguardando confirmação/conclusão;
  - `expired`: exibir planos ou botão para nova tentativa, em vez de "Pagamento em processamento";
  - texto deve indicar que o checkout expirou e o usuário pode tentar novamente.
- Ao iniciar nova assinatura após `expired`, reaproveitar `providerCustomerId` existente para evitar criar novo cliente no Asaas.

## Test Plan

- Unitários do mapper:
  - `CHECKOUT_EXPIRED` vira `checkout_expired` com checkout id, customer e externalReference;
  - `SUBSCRIPTION_CREATED` extrai `providerSubscriptionId`, `providerCustomerId` e `checkoutSession`;
  - `PAYMENT_CONFIRMED` continua ativando como antes.
- Unitários do `WebhookProcessor`:
  - checkout expirado muda `pending -> expired`;
  - checkout expirado não altera assinatura `active`;
  - assinatura criada no Asaas preenche `providerSubscriptionId` sem ativar acesso;
  - pagamento confirmado localiza por `providerSubscriptionId` ou customer e ativa.
- Unitários do `BillingService`:
  - checkout envia `externalReference = subscription.id`;
  - `providerCheckoutId` é persistido após retorno do Asaas;
  - falha ao criar checkout não deixa assinatura presa em `pending` sem `providerCheckoutId`.
- Teste de reconciliação:
  - pendência vencida sem assinatura Asaas vira `expired`.
- Teste web:
  - `expired` permite nova tentativa;
  - `pending` continua sem acesso ao produto.
- Regressão:
  - fluxo feliz do customer equivalente a `cus_000008405667` continua: `CHECKOUT_CREATED` → `SUBSCRIPTION_CREATED` → `PAYMENT_CONFIRMED` → assinatura `active`.

## Assumptions

- Documento alvo: `plan/asaas-checkout-expiration-handling-plan.md`.
- `externalReference` será o `Subscription.id`, não `userId`, para distinguir múltiplas tentativas do mesmo usuário.
- `CHECKOUT_PAID` será ignorado para acesso; apenas `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` ativam.
- `SUBSCRIPTION_CREATED` registra vínculo externo, mas não concede acesso sozinho.
- `CHECKOUT_EXPIRED` só expira assinatura ainda `pending`; eventos fora de ordem não revogam assinatura já ativa.
