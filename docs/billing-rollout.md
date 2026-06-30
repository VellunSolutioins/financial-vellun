# Rollout — Gateway de Pagamento e Assinaturas

Guia operacional para liberar a cobrança recorrente com segurança (doc Fase 7).

## Feature flag de obrigatoriedade

A obrigatoriedade de assinatura é controlada pela variável de ambiente da API:

```
BILLING_ENFORCEMENT_ENABLED=true   # padrão: obrigatoriedade ativa
BILLING_ENFORCEMENT_ENABLED=false  # soft launch: não bloqueia ninguém
```

- **Fonte única:** `SubscriptionAccessService.isEnforced()` na API. É respeitada pelo
  `ActiveSubscriptionGuard` (web/API), pelo guard dos endpoints internos e pelo
  endpoint `GET /internal/users/{userId}/subscription-access` — de onde o agente de
  IA (WhatsApp) deriva o bloqueio. **Não há flag separada no agente**: ele confia
  na resposta da API.
- Com a flag `false`, o produto funciona normalmente sem assinatura (período de
  soft launch / beta). Ao virar `true`, a regra passa a valer em web, API e WhatsApp
  de forma consistente.

## Estágios de rollout

1. **Mocks locais** — testes unitários/integração (Jest/pytest) sem rede.
2. **Sandbox Asaas** — `ASAAS_API_URL` apontando para o sandbox; fluxo feliz
   (cadastro → checkout → webhook → `active`), webhook duplicado/inválido.
3. **Staging** — `BILLING_ENFORCEMENT_ENABLED=false`; valida billing sem bloquear.
4. **Testes internos / beta** — grupo pequeno; acompanhar conversão e webhooks.
5. **Produção (soft launch)** — flag `false`; cobrança disponível, sem bloqueio.
6. **Ativação progressiva** — virar a flag para `true` (idealmente por coorte) e
   monitorar. Reverter é só voltar a flag para `false`.

## Pré-produção (Prompt 0)

Antes do estágio 5: conta Asaas homologada, `ASAAS_API_KEY`/`ASAAS_WEBHOOK_TOKEN`
de produção, preços finais no seed, e os itens jurídicos/PCI/fiscais do Prompt 0.

## Monitoramento

Métricas operacionais a acompanhar (doc Fase 7):

- conversão de checkout (iniciados × ativados);
- pagamentos aprovados × recusados;
- assinaturas em `past_due` e em grace;
- falhas de webhook e **tamanho da DLQ** (`payment_webhook_events` com `status = failed`);
- divergências detectadas pela reconciliação (`SubscriptionAudit` com ator `reconciliation`);
- chargebacks e cancelamentos;
- latência/erros das chamadas ao Asaas;
- custo de IA evitado por bloqueio de assinatura (`subscription_blocked` no agente).

## Cenários críticos cobertos por testes automatizados

Unitários (Jest, `apps/api`): máquina de estados e transições inválidas; cálculo de
acesso e grace; idempotência de webhook; sanitização de payload; mapeamento de
eventos; pagamento aprovado/recusado (primeira cobrança × renovação); chargeback
(revoga acesso); reembolso; cancelamento; indisponibilidade do PSP (reprocessável);
reconciliação (correção/divergência); guard de assinatura e feature flag;
CSRF; comparação segura da `INTERNAL_API_KEY`.

Agente (pytest, `apps/ai-agent`): gate de assinatura (libera/bloqueia/fail-closed);
bloqueio antes de LLM/STT/Vision.

> Cenários e2e ponta a ponta contra o **sandbox Asaas** (cadastro→ativação,
> inadimplência→bloqueio→reativação) dependem das credenciais do Prompt 0 e são
> executados nos estágios 2–4.
