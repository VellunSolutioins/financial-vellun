# Análise do módulo de billing — Financial Vellun

Data: 12/10/2026. Escopo: revisão estática de `apps/api/src/billing/` (adapter do Asaas, webhook, reconciliação, serviços de assinatura e pagamento), dos modelos de billing em `apps/api/prisma/schema.prisma` e do plano gratuito em `apps/api/prisma/seed.ts`. O comportamento do Asaas foi conferido na documentação pública (docs.asaas.com), não no sandbox. Nenhum teste foi executado e nenhum cenário foi reproduzido. Não é um pentest.

A análise responde a quatro perguntas:

1. O módulo é independente do gateway de pagamento?
2. Existem vulnerabilidades?
3. O webhook lida com todos os eventos enviados pelo Asaas?
4. O webhook processa tudo de forma síncrona, e onde há risco de dual write?

## Avaliação

- **Gateway:** a troca é barata em código (um adapter novo e uma linha no módulo), mas migrar com assinaturas vivas exige mudança de schema, porque não há suporte a dois gateways ao mesmo tempo.
- **Vulnerabilidades:** duas falhas de gravidade alta fazem um inadimplente voltar a ter acesso. Há mais cinco achados de gravidade média ou baixa.
- **Eventos:** nenhum evento do Asaas quebra o webhook, mas só 10 são tratados, e alguns dos ignorados fazem falta.
- **Fluxo:** o request faz uma única escrita e responde. O processamento roda depois, no mesmo processo, em até seis escritas separadas e sem transação. Os riscos de dual write estão nesses dois pontos e nos fluxos de cancelamento e checkout.

Os achados 2.1 e 2.2 devem ser reproduzidos no sandbox antes da correção, porque dependem de comportamento do Asaas confirmado apenas pela documentação.

---

## 1. Independência do gateway

**Conclusão: em boa parte sim. Trocar de gateway não exige reescrever o módulo, mas migrar com assinaturas vivas exige mudança de schema.**

### 1.1 O que está bem isolado

- Todo o código que fala com o Asaas vive em `apps/api/src/billing/providers/asaas/`, e as variáveis `ASAAS_*` só são lidas ali.
- Serviços, webhook, reconciliação e guard dependem apenas do contrato em `providers/payment-provider.interface.ts`.
- O processador de webhook trabalha com intenções normalizadas (`payment_succeeded`, `payment_failed` etc.), nunca com o payload cru do Asaas.
- Trocar de gateway é escrever um adapter novo e mudar uma linha em `billing.module.ts:37`.

### 1.2 O que vaza ou falta

**Dois gateways ao mesmo tempo não são suportados.** `Subscription`, `Payment` e `PaymentWebhookEvent` não têm coluna `provider`, o bind do provider é estático (`useClass`) e a rota `/billing/webhook` é única. Numa migração real, as assinaturas antigas continuam no Asaas enquanto as novas nascem no gateway novo, e a reconciliação mandaria IDs do Asaas para o provider novo.

**Regra do Asaas no domínio.** `assertBillingProfileComplete` em `billing.service.ts:115` exige telefone e endereço completo antes do checkout. Isso é requisito do Asaas, não do produto.

**Contrato implícito de status.** `ProviderSubscription.status` e `ProviderPayment.status` são `string`. A reconciliação depende dos literais `'active'`, `'canceled'` e `'expired'`, que nenhum tipo garante.

**Semântica de cancelamento.** O adapter ignora o parâmetro `cancelAtPeriodEnd` e sempre faz `DELETE` da assinatura no Asaas (`asaas-payment.provider.ts:131`). O domínio compensa com `isCancellationDeferred`.

**Erros.** O adapter lança exceções HTTP do NestJS e deixa `AsaasApiError` escapar em `getSubscription`, `cancelSubscription` e `refundPayment`. Não existe um tipo de erro de provider neutro.

---

## 2. Vulnerabilidades

| #   | Gravidade   | Problema                                            |
| --- | ----------- | --------------------------------------------------- |
| 2.1 | Alta        | Reconciliação reativa inadimplente e chargeback     |
| 2.2 | Alta        | `PAYMENT_RECEIVED` tardio reativa a assinatura      |
| 2.3 | Média-alta  | Risco de cobrança em dobro                          |
| 2.4 | Média       | Evento pode ficar órfão em `received`               |
| 2.5 | Média       | Webhook confia no payload                           |
| 2.6 | Média-baixa | Reconciliação olha sempre as mesmas 200 assinaturas |
| 2.7 | Baixa       | Itens menores                                       |

### 2.1 Alta — reconciliação reativa inadimplente e chargeback

Evidência: `apps/api/src/billing/reconciliation.service.ts:159` (`targetFromRemote`) e `:61` (seleção de candidatas).

A reconciliação horária mapeia a assinatura remota com status `ACTIVE` para `active` local. No Asaas, esse status só controla a geração de cobranças e não reflete pagamento. A documentação afirma que a criação da assinatura não representa a confirmação de um pagamento.

Como as candidatas incluem `past_due` e `unpaid`, e a máquina de estados permite `past_due → active` e `unpaid → active`, uma assinatura com cobrança vencida ou com chargeback volta a `active` em até uma hora. O status `active` nunca confere `currentPeriodEnd` (`subscription-access.service.ts:71`), então o acesso fica por tempo indefinido.

Não há teste cobrindo o caso "local `past_due`, remoto `active`" em `reconciliation.service.spec.ts`.

### 2.2 Alta — `PAYMENT_RECEIVED` tardio reativa a assinatura

Evidência: `apps/api/src/billing/providers/asaas/asaas-webhook.mapper.ts:10`; `apps/api/src/billing/webhook/webhook.processor.ts:195` (`handleSuccess`).

No cartão de crédito, o Asaas envia `PAYMENT_CONFIRMED` no momento do pagamento e `PAYMENT_RECEIVED` cerca de 32 dias depois, para a mesma cobrança, quando o saldo fica disponível. Os dois eventos são mapeados para `payment_succeeded` e caem em `handleSuccess`, que ativa a assinatura sem checar se aquele pagamento já foi aplicado.

Consequências:

- Se a renovação falhou no dia 30, o `PAYMENT_RECEIVED` do mês anterior, no dia 32, leva `past_due → active` e zera o `graceUntil`.
- Uma assinatura `canceled` é reativada temporariamente, porque `canceled → active` é uma transição permitida.

### 2.3 Média-alta — risco de cobrança em dobro

Evidência: `apps/api/src/billing/providers/asaas/asaas-payment.provider.ts:120` (`createPaymentMethodUpdateSession` lança `NotImplementedException`); `apps/api/src/billing/billing.service.ts:52` e `:95`; `apps/api/src/billing/services/subscription.service.ts:95`.

A atualização de cartão não está implementada. Durante o grace, o inadimplente não consegue refazer o checkout, porque a API responde que já existe assinatura ativa. Depois que o grace expira, o novo checkout cria uma segunda assinatura no Asaas sem cancelar a primeira, que continua tentando cobrar.

### 2.4 Média — evento pode ficar órfão em `received`

Evidência: `apps/api/src/billing/webhook/webhook.processor.ts:63` (`enqueue`); `apps/api/src/billing/webhook/webhook-retry.service.ts:85` e `:129`.

O webhook responde 200 e agenda o processamento com `setImmediate`. Se o processo cair nesse intervalo, o evento fica com status `received`. A varredura só procura eventos `failed` com retry vencido e eventos presos em `processing`. O Asaas não reenvia, porque recebeu 200.

O evento aparece no painel de operações como não resolvido, mas não se recupera sozinho.

### 2.5 Média — webhook confia no payload

Evidência: `apps/api/src/billing/providers/asaas/asaas-payment.provider.ts:159` (`verifyWebhook`); `apps/api/src/billing/webhook/webhook.processor.ts:195`.

A autenticação é um token estático enviado no header `asaas-access-token`. Essa é uma limitação do Asaas, que não oferece assinatura HMAC. A implementação está correta nesse ponto: comparação em tempo constante e rejeição quando o token não está configurado.

O problema é que `handleSuccess` não consulta a cobrança no Asaas. A chamada a `getSubscription` serve apenas para buscar a data do fim do período, e só acontece quando o evento traz o ID da assinatura. Quem tiver o token e um ID de cliente (`cus_...`) consegue ativar uma assinatura sem nenhuma chamada ao Asaas.

Correção: adicionar `getPayment` à interface do provider e usar o webhook apenas como aviso, confirmando o estado real da cobrança antes de conceder acesso.

### 2.6 Média-baixa — reconciliação olha sempre as mesmas 200 assinaturas

Evidência: `apps/api/src/billing/reconciliation.service.ts:74`.

O lote ordena por `updatedAt asc` com `take: 200`. Assinaturas consistentes não são alteradas, então o `updatedAt` delas não muda e elas continuam no topo da fila. Acima de 200 assinaturas, as mais novas nunca são verificadas.

### 2.7 Baixa — itens menores

- **Valor pago não é validado.** O valor do pagamento nunca é comparado com o preço do plano. A assinatura `pending` aponta para o último plano escolhido, não para o checkout que foi efetivamente pago.
- **Clientes órfãos no Asaas.** Quando o checkout falha depois de `createCustomer`, o cliente criado no Asaas não é registrado localmente.
- **Cancelamento não idempotente.** Chamar `cancel` duas vezes provavelmente retorna 500, porque o `DELETE` repetido falha no Asaas.
- **Plano de R$ 0,00.** Um plano gratuito ativo concede acesso sem expiração (`billing.service.ts:63`). A proteção existe apenas no seed, que desativa o plano em produção, e não no código do checkout.
- **Estorno mantém o acesso.** `PAYMENT_REFUNDED` apenas registra o pagamento como estornado. A assinatura continua `active`.

---

## 3. Cobertura de eventos do webhook

**Conclusão: o webhook não quebra com nenhum evento, mas só trata 10.**

Um evento desconhecido é persistido, normalizado como `ignore`, marcado como processado e respondido com 200. A fila do Asaas não pausa por causa disso. O fluxo de persistir, responder e processar com idempotência pelo `id` do evento segue a recomendação do Asaas.

### 3.1 Eventos tratados

| Evento                                 | Intenção interna        |
| -------------------------------------- | ----------------------- |
| `PAYMENT_CONFIRMED`                    | `payment_succeeded`     |
| `PAYMENT_RECEIVED`                     | `payment_succeeded`     |
| `PAYMENT_OVERDUE`                      | `payment_failed`        |
| `PAYMENT_REFUNDED`                     | `payment_refunded`      |
| `PAYMENT_PARTIALLY_REFUNDED`           | `payment_refunded`      |
| `PAYMENT_CHARGEBACK_REQUESTED`         | `payment_chargeback`    |
| `PAYMENT_CHARGEBACK_DISPUTE`           | `payment_chargeback`    |
| `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` | `payment_chargeback`    |
| `SUBSCRIPTION_DELETED`                 | `subscription_canceled` |
| `SUBSCRIPTION_INACTIVATED`             | `subscription_canceled` |

### 3.2 Eventos ignorados que fazem falta

| Evento                                                                                      | Consequência hoje                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CHECKOUT_EXPIRED`, `CHECKOUT_CANCELED`                                                     | A assinatura fica presa em `pending`. O plano em `plan/asaas-checkout-expiration-handling-plan.md` não foi implementado.                 |
| `SUBSCRIPTION_CREATED`                                                                      | O `providerSubscriptionId` só é gravado no primeiro pagamento. Até lá, a correlação é feita pelo cliente.                                |
| `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`, `PAYMENT_REPROVED_BY_RISK_ANALYSIS`                  | Cartão recusado na primeira cobrança não gera retorno ao usuário. Na renovação, só o `PAYMENT_OVERDUE` do dia seguinte sinaliza a falha. |
| `PAYMENT_DELETED`, `PAYMENT_RESTORED`, `PAYMENT_UPDATED`, `PAYMENT_RECEIVED_IN_CASH_UNDONE` | A tabela `payments` diverge do Asaas quando alguém altera cobranças pelo painel do Asaas.                                                |

### 3.3 Detalhes

- `PAYMENT_PARTIALLY_REFUNDED` é gravado como `refunded`, como se o estorno fosse integral.
- O plano de checkout expirado assume que o payload de checkout traz `externalReference`. A documentação do Asaas não lista esse campo nos eventos de checkout. O vínculo documentado é `checkout.id`.

---

## 4. Fluxo do webhook

**Conclusão: não é tudo síncrono.** O request faz uma escrita e responde. O processamento acontece depois, no mesmo processo.

### 4.1 Parte síncrona, dentro do request

Evidência: `apps/api/src/billing/billing-webhook.controller.ts:28`.

1. Valida o token e faz o parse do JSON, sem I/O.
2. Faz `INSERT` em `payment_webhook_events` com status `received`. A idempotência vem do `providerEventId` único.
3. Agenda o processamento em memória com `setImmediate`.
4. Responde 200.

### 4.2 Parte assíncrona, no mesmo processo

Evidência: `apps/api/src/billing/webhook/webhook.processor.ts:118`.

Para um `PAYMENT_CONFIRMED`:

| #   | Passo                                                         | Tipo         |
| --- | ------------------------------------------------------------- | ------------ |
| 1   | `markProcessing` (reivindicação atômica do evento)            | escrita      |
| 2   | `locate` da assinatura                                        | leitura      |
| 3   | `getSubscription` no Asaas (timeout de 10s, até 3 tentativas) | HTTP externo |
| 4   | `UPDATE` da assinatura para `active`                          | escrita      |
| 5   | `INSERT` da auditoria                                         | escrita      |
| 6   | `UPSERT` do pagamento                                         | escrita      |
| 7   | `linkSubscription` (best-effort)                              | escrita      |
| 8   | `markProcessed`                                               | escrita      |

Cada escrita é um commit independente. O RabbitMQ do projeto não participa desse fluxo: a fila é a própria tabela `payment_webhook_events`, e o retry é o cron de minuto em minuto que lê `next_retry_at`. O desenho é um inbox pattern cujo primeiro salto, o `setImmediate`, não é durável.

---

## 5. Problemas de dual write

### 5.1 `INSERT` do evento e agendamento em memória

Se o processo cair entre o commit do `INSERT` e a execução do `setImmediate`, o evento fica em `received` para sempre. É a mesma causa do achado 2.4.

Correção: a varredura também reivindicar eventos `received` com mais de alguns segundos.

### 5.2 Assinatura, auditoria e pagamento fora de uma transação

Uma falha no meio deixa estado parcial, e o evento vai para retry. O retry reaplica tudo, e os handlers não são totalmente idempotentes:

- **Grace estendido.** `handleFailure` calcula `graceUntil` a partir do momento da execução. Como `past_due → past_due` é uma transição permitida, cada retry empurra o prazo. Um evento esgotado e recuperado pelo painel dias depois concede mais 3 dias.
- **Período reescrito.** `handleSuccess` grava `currentPeriodStart = new Date()` a cada tentativa.
- **Auditoria errada.** Se o `UPDATE` da assinatura passou e a auditoria falhou, o retry registra `active->active`, e a transição real `pending->active` nunca aparece.

### 5.3 Efeitos aplicados e `markProcessed`

Se o passo 8 falhar, o evento é reprocessado inteiro, com os mesmos efeitos do item 5.2.

Além disso, a métrica `processed` é incrementada antes do `UPDATE` em `webhook-event.service.ts:93`. Ela conta mesmo quando a gravação falha.

### 5.4 Pagamento sem assinatura local é marcado como processado

Evidência: `apps/api/src/billing/webhook/webhook.processor.ts:147`.

Quando `locate` não encontra a assinatura, o processador apenas loga um aviso e segue para `markProcessed`. Isso acontece, por exemplo, se o checkout foi criado no Asaas mas a gravação da assinatura `pending` local falhou.

O cliente pagou, não tem acesso, e o evento aparece como resolvido. A reconciliação não cobre esse caso, porque não existe `providerSubscriptionId` local.

### 5.5 Cancelamento: Asaas primeiro, banco depois

Evidência: `apps/api/src/billing/billing.service.ts:160`.

O `DELETE` no Asaas acontece antes da gravação de `cancelAtPeriodEnd = true`. Se a gravação falhar, ou se o evento `SUBSCRIPTION_DELETED` chegar antes dela, o webhook encontra a flag falsa e cancela imediatamente. O usuário perde o resto do período que já pagou.

Correção: gravar a intenção local primeiro e reverter se a chamada ao Asaas falhar.

### 5.6 Checkout: duas chamadas ao Asaas, depois o banco

Evidência: `apps/api/src/billing/billing.service.ts:80`.

O `providerCustomerId` só é persistido no fim do fluxo. Qualquer falha depois de `createCustomer` deixa um cliente órfão no Asaas, e a próxima tentativa cria outro.

---

## 6. Concorrência

- **Eventos da mesma assinatura rodam em paralelo.** Cada request dispara seu próprio `setImmediate`, e o cron de retry roda junto. Não há serialização por assinatura.
- **`transitionTo` não é atômico.** O método lê, valida e atualiza sem incluir o `status` no `where` (`subscription.service.ts:171`). Vale a última escrita.
- **Retry inverte a ordem dos eventos.** Um `PAYMENT_OVERDUE` que falhou e voltou 30 segundos depois pode ser aplicado após o `PAYMENT_CONFIRMED` e levar `active → past_due`. Nenhum handler compara a data do evento com o último estado aplicado.

---

## 7. O que já está correto

- Token do webhook comparado em tempo constante, com rejeição quando não configurado.
- Evento persistido antes do processamento, com idempotência por `providerEventId`.
- Reivindicação atômica do evento: duas réplicas não processam o mesmo evento.
- Retry durável em banco, com backoff em buckets e estado `exhausted` visível.
- Upsert de pagamento por `providerPaymentId`.
- Recuperação de evento esgotado pelo painel, com reivindicação e auditoria na mesma transação.
- Sanitização do payload antes de persistir, removendo dados de cartão e segredos.
- Plano gratuito desativado pelo seed quando `NODE_ENV=production`.

---

## 8. Ordem sugerida de correção

1. **Achados 2.1 e 2.2**, depois de reproduzidos no sandbox. São os que permitem acesso sem pagamento.
2. **Itens 5.2 e 5.3 numa única mudança:** uma transação cobrindo assinatura, auditoria, pagamento e `markProcessed`, com a chamada ao Asaas feita antes dela.
3. **Itens 5.1, 5.4 e 5.5:** correções pontuais e independentes entre si.
4. **Demais achados**, conforme prioridade do produto.

---

## 9. Reprodução no sandbox do Asaas

Feita em 12/10/2026, apenas com consultas (`GET`) à conta de sandbox. Nenhuma escrita foi feita no Asaas. Os eventos de webhook não foram observados diretamente: o banco local não tinha eventos gravados, então o que segue vem do estado dos objetos na API.

| #   | Pergunta                                              | Resultado                                                                                                                                                                                             |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | Assinatura com cobrança vencida continua `ACTIVE`?    | **Sim.** `sub_1ng4sqsbqnsas1e5` está `ACTIVE` com duas cobranças `OVERDUE` (15/08 e 15/09) e continua gerando as seguintes. Confirma o achado 2.1.                                                    |
| b   | `PAYMENT_RECEIVED` vem depois de `PAYMENT_CONFIRMED`? | **Sim, pelas datas.** Na cobrança `pay_fp6u3hdnvttq3ztj`, `confirmedDate` é 15/07 e `paymentDate` (crédito) é 17/08, 33 dias depois. Nesse dia a cobrança de 15/08 já estava vencida. Confirma o 2.2. |
| c   | `GET` de assinatura removida                          | Responde 200 com `deleted: true` e `status: INACTIVE`.                                                                                                                                                |
| d   | Segundo `DELETE` da mesma assinatura                  | **Não testado**, por ser escrita. O adapter passou a tratar 404 como sucesso.                                                                                                                         |
| e   | Cobrança e assinatura trazem `checkoutSession`?       | **Sim**, as duas, nas respostas da API. No payload do webhook não foi conferido.                                                                                                                      |
| f   | `GET /subscriptions/{id}/payments`                    | 10 por página, da mais nova para a mais antiga. Inclui cobranças futuras já geradas, ainda `PENDING`.                                                                                                 |
| g   | `GET /customers?externalReference=`                   | Devolve o cliente criado com aquele valor, e lista vazia quando não existe.                                                                                                                           |

### 9.1 Achado novo: `nextDueDate` não é o fim do período pago

O Asaas gera as cobranças cerca de 40 dias antes do vencimento. Numa assinatura mensal criada em 15/07, o `nextDueDate` consultado em 12/10 era 15/12, dois ciclos à frente.

O código gravava esse valor em `currentPeriodEnd`. Consequências:

- a data de "próxima cobrança" mostrada ao usuário ficava um ou dois meses adiantada;
- o cancelamento agendado (`isCancellationDeferred`) mantinha o acesso além do período realmente pago.

Correção, feita junto com a entrega 1: o período passa a ser derivado da cobrança paga (`vencimento` até `vencimento + ciclo`).

### 9.2 Achado novo: data de pagamento trocada pela data de crédito

`paidAt` era lido primeiro de `paymentDate`, que no cartão é a data do crédito. Depois do `PAYMENT_RECEIVED`, o pagamento aparecia como feito 33 dias mais tarde. O adapter passou a preferir `confirmedDate`.

### 9.3 Achado novo: grace renovado a cada cobrança vencida

Uma assinatura já `past_due` recebia novo `graceUntil` a cada cobrança vencida, o que dava 3 dias de acesso por mês sem pagamento. Agora só quem estava em dia (`active` ou `trialing`) entra em grace.
