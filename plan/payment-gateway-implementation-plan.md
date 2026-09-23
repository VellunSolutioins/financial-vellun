# Plano de Implementação de Gateway de Pagamento

## 1. Objetivo

Implementar cobrança recorrente no Financial Vellun para que somente usuários com direito de acesso vigente possam utilizar os serviços do produto.

A recomendação é não implementar um gateway próprio. O PSP escolhido para a primeira versão é o **Asaas**, utilizando checkout hospedado ou tokenização fornecida pelo próprio Asaas, cobrança recorrente por cartão e webhooks. Essa abordagem reduz o risco de segurança, o esforço operacional e o escopo de conformidade com PCI DSS.

Este documento considera:

- operação inicial no Brasil;
- cobranças em BRL;
- assinaturas recorrentes pagas exclusivamente por cartão de crédito;
- Asaas como PSP inicial;
- uso do produto pelo web, API e WhatsApp/IA;
- requisitos de segurança, LGPD, PCI DSS e proteção do consumidor.

Pix, Pix Automático, boleto e outros meios de pagamento não fazem parte do escopo inicial. A arquitetura continuará abstraindo o provedor e o meio de pagamento para permitir evolução futura sem reescrever o domínio de assinaturas.

## 2. Arquitetura Recomendada

```text
Usuário ──► Web ──► API NestJS ──► Asaas
                       │              │
                       │◄── webhook ──┘
                       │
                       ├── PostgreSQL: planos, assinaturas e pagamentos
                       │
                       └── controle central de acesso
                              ├── Web/API
                              └── WhatsApp/IA
```

O Asaas será responsável pela coleta e tokenização dos dados do cartão, criação das cobranças recorrentes e processamento financeiro. A aplicação deverá armazenar somente identificadores externos, estado da assinatura e informações não sensíveis necessárias ao negócio.

O backend do Financial Vellun não deverá receber número completo do cartão ou CVV. A integração deverá priorizar o Checkout Asaas com assinatura recorrente. Se algum fluxo exigir formulário incorporado, a tokenização deverá ocorrer diretamente entre o navegador e o Asaas.

## 3. Situação Atual do Projeto

O projeto já possui uma base adequada para a integração:

- NestJS, Prisma e PostgreSQL na API;
- autenticação JWT em cookies HTTP-only;
- Next.js no frontend;
- integração interna com WhatsApp e agente de IA;
- isolamento dos dados por `userId`.

Os principais pontos que precisam ser alterados são:

- `User` não possui estado comercial ou assinatura;
- o login aceita qualquer usuário existente;
- `JwtAuthGuard` valida identidade, mas não o direito de uso do produto;
- os endpoints internos da IA liberam usuários pelo telefone sem verificar assinatura;
- o middleware do Next.js atualmente não protege rotas;
- web, API e IA podem acessar o produto por caminhos diferentes.

O controle de assinatura deve ser centralizado na API. Bloqueios implementados somente no frontend não protegem endpoints nem o canal de WhatsApp.

## 4. Modelo de Domínio

### 4.1 Plano

```text
Plan
- id
- code
- name
- description
- price
- currency
- interval
- isActive
- features
- createdAt
- updatedAt
```

### 4.2 Assinatura

```text
Subscription
- id
- userId
- planId
- providerCustomerId
- providerSubscriptionId
- status
- currentPeriodStart
- currentPeriodEnd
- trialEndsAt
- graceUntil
- cancelAtPeriodEnd
- canceledAt
- createdAt
- updatedAt
```

No Asaas:

- `providerCustomerId` corresponde ao identificador do cliente;
- `providerSubscriptionId` corresponde ao identificador da assinatura;
- cada recorrência gera uma cobrança própria, cujo identificador será armazenado em `Payment.providerPaymentId`;
- o plano e suas funcionalidades continuam sendo entidades internas do Financial Vellun.

Estados recomendados:

```text
pending
trialing
active
past_due
canceled
unpaid
expired
```

Não deve ser utilizado apenas um campo como `user.isActive`. O estado comercial precisa representar período de teste, inadimplência, cancelamento futuro, expiração e tolerância de pagamento.

### 4.3 Pagamento

```text
Payment
- id
- userId
- subscriptionId
- providerPaymentId
- amount
- currency
- status
- paymentMethodType
- dueAt
- paidAt
- failedAt
- createdAt
- updatedAt
```

Estados possíveis:

```text
pending
processing
paid
failed
refunded
partially_refunded
chargeback
canceled
```

### 4.4 Eventos de webhook

```text
PaymentWebhookEvent
- id
- providerEventId
- eventType
- status
- attempts
- receivedAt
- processedAt
- sanitizedPayload
- lastError
```

`providerEventId` deve possuir uma restrição única para garantir idempotência.

### 4.5 Auditoria

Também é recomendável uma entidade de auditoria para registrar:

- alteração de plano;
- ativação e bloqueio;
- cancelamento;
- reembolso;
- mudança manual feita por administrador;
- origem da alteração;
- estado anterior e posterior.

## 5. Regra Central de Acesso

Criar um serviço central de autorização comercial:

```typescript
SubscriptionAccessService.canUseProduct(userId);
```

A conta poderá utilizar o produto quando estiver:

- `active`;
- `trialing`, enquanto o período de teste for válido;
- `past_due`, somente durante `graceUntil`, caso exista política de tolerância.

Criar um `ActiveSubscriptionGuard` na API para proteger:

- lançamentos;
- contas;
- categorias;
- contatos;
- dashboards;
- endpoints internos usados pelo agente de IA;
- processamento de mensagens do WhatsApp.

Devem permanecer acessíveis sem assinatura ativa:

- cadastro e login;
- consulta do estado da assinatura;
- listagem dos planos disponíveis;
- criação de checkout;
- acesso ao portal de cobrança;
- atualização do meio de pagamento;
- cancelamento;
- logout;
- exportação e exclusão de dados, conforme a política legal;
- canais de suporte.

Usuários inadimplentes devem conseguir autenticar-se e acessar a área de cobrança. Bloquear completamente o login dificulta a regularização da assinatura e o exercício de direitos relacionados aos dados pessoais.

Resposta recomendada para falta de assinatura:

```json
{
  "statusCode": 403,
  "code": "SUBSCRIPTION_REQUIRED",
  "message": "É necessária uma assinatura ativa."
}
```

No canal de WhatsApp, a verificação deve acontecer antes de chamadas ao LLM, transcrição ou outras operações pagas. Isso evita custos de processamento para contas sem acesso.

## 6. Fluxos Principais

### 6.1 Nova assinatura

1. O usuário cria uma conta.
2. A API cria ou recupera o cliente no PSP.
3. A API cria uma sessão de checkout.
4. O usuário paga no ambiente hospedado ou no componente tokenizado do PSP.
5. O PSP envia um webhook de pagamento ou assinatura.
6. A API valida e registra o webhook.
7. O processamento assíncrono atualiza a assinatura para `active`.
8. O usuário recebe acesso ao produto.

O redirecionamento do navegador após o checkout não deve ativar a assinatura. A ativação deve ocorrer somente após webhook validado ou consulta autenticada ao PSP.

### 6.2 Renovação e inadimplência

1. O PSP tenta realizar a cobrança.
2. O webhook confirma o pagamento ou informa a falha.
3. Em caso de sucesso, a aplicação atualiza o período da assinatura.
4. Em caso de falha, a assinatura passa para `past_due`.
5. Durante `graceUntil`, o produto pode manter acesso temporário.
6. Após o período de tolerância, o acesso é bloqueado.
7. O usuário é informado por e-mail ou WhatsApp sem exposição de dados financeiros.

### 6.3 Cancelamento

A política recomendada é cancelar ao final do período já pago:

```text
status = active
cancelAtPeriodEnd = true
```

O acesso continua até `currentPeriodEnd`.

Cancelamento imediato, estorno, reembolso parcial e chargeback devem ser tratados como operações diferentes.

### 6.4 Alteração de plano

Definir previamente:

- se haverá upgrade imediato;
- se haverá cobrança proporcional;
- se downgrade será aplicado somente no próximo ciclo;
- como créditos serão tratados;
- como limites de funcionalidades serão recalculados.

Essa regra deve existir no domínio da aplicação e não ficar implícita apenas no comportamento do PSP.

## 7. Webhooks e Consistência

O webhook é a principal fonte de atualização do estado comercial, mas não deve ser a única defesa contra inconsistências.

Requisitos:

- validar a assinatura criptográfica usando o corpo HTTP bruto;
- validar timestamp quando o PSP oferecer esse recurso;
- rejeitar assinaturas inválidas;
- registrar `providerEventId` antes do processamento;
- suportar eventos duplicados;
- suportar eventos fora de ordem;
- responder rapidamente ao PSP;
- processar os eventos em fila;
- implementar retry com backoff;
- enviar falhas permanentes para uma dead-letter queue;
- manter histórico de tentativas;
- mascarar ou eliminar dados sensíveis do payload persistido.

Também deve existir uma rotina periódica de reconciliação:

1. selecionar assinaturas recentemente alteradas ou inconsistentes;
2. consultar o estado real no PSP;
3. comparar com o banco local;
4. corrigir divergências de forma auditável;
5. gerar alerta operacional.

## 8. Segurança de Pagamentos

### 8.1 Dados de cartão

- Nunca receber ou armazenar PAN completo.
- Nunca armazenar CVV, senha, trilha magnética ou PIN.
- Não enviar dados de cartão pela API do Financial Vellun.
- Utilizar checkout hospedado, redirect ou componente tokenizado do PSP.
- Armazenar apenas token ou identificador fornecido pelo PSP, bandeira, últimos quatro dígitos e vencimento quando estritamente necessário.

### 8.2 Segredos

- Manter chaves do PSP somente no backend.
- Usar secret manager em produção.
- Separar credenciais de sandbox e produção.
- Definir processo de rotação.
- Nunca registrar segredos em logs ou erros.
- Restringir permissões da credencial ao mínimo necessário.

### 8.3 API e sessão

- Implementar proteção CSRF para operações autenticadas por cookies.
- Aplicar rate limiting em login, cadastro, checkout e billing.
- Rotacionar e permitir revogação de refresh tokens.
- Usar cookies `Secure`, `HttpOnly` e com política `SameSite` adequada.
- Configurar Helmet, CSP e demais headers de segurança.
- Proteger ou desabilitar o Swagger em produção.
- Exigir MFA para contas administrativas.

O uso atual de `SameSite=None` em produção exige uma análise específica de CSRF. A autenticação por cookie não é suficiente para impedir requisições iniciadas por sites maliciosos.

### 8.4 API interna e agente de IA

- Restringir comunicação entre API e agente por rede privada quando possível.
- Rotacionar a `INTERNAL_API_KEY`.
- Comparar credenciais de maneira segura.
- Avaliar autenticação de serviço com credenciais curtas, assinatura de requisição ou mTLS.
- Não aceitar `userId` arbitrário sem validar o vínculo do usuário e sua assinatura.
- Verificar assinatura antes de listar contas, categorias ou criar lançamentos pela IA.

### 8.5 Telefone e WhatsApp

O cadastro atual marca o telefone do WhatsApp como verificado sem confirmação por OTP. Isso deve ser corrigido antes de utilizar o WhatsApp para ações financeiras ou notificações de cobrança.

Fluxo recomendado:

1. usuário informa o telefone;
2. sistema envia código ou link de confirmação;
3. usuário confirma a posse;
4. somente então `isVerified` passa para `true`.

### 8.6 Infraestrutura

- TLS em todos os ambientes públicos.
- Banco e backups criptografados.
- Testes periódicos de restauração.
- Controle de acesso baseado em função.
- Princípio de menor privilégio.
- Logs centralizados e protegidos contra alteração.
- Alertas de segurança e disponibilidade.
- SAST, análise de dependências e secret scanning no CI.
- Testes de vulnerabilidade antes da produção.

## 9. PCI DSS

O padrão de referência atual é o PCI DSS 4.0.1.

Mesmo utilizando checkout hospedado, o Financial Vellun continua responsável por confirmar com o adquirente ou assessor:

- qual questionário de autoavaliação é aplicável;
- se a implementação atende aos requisitos para SAQ A;
- quais componentes do sistema podem impactar a segurança da página de pagamento;
- quais evidências e validações periódicas serão exigidas.

A arquitetura deve ser desenhada para manter os dados de cartão fora do ambiente do Financial Vellun e reduzir o Cardholder Data Environment.

Referências:

- [PCI DSS 4.0.1 — Document Library](https://www.pcisecuritystandards.org/document_library/)
- [PCI Data Security Standard](https://www.pcisecuritystandards.org/standards/pci-dss/)

## 10. LGPD e Privacidade

O Financial Vellun provavelmente atuará como controlador dos dados dos usuários. O papel do PSP pode variar entre operador e controlador independente, conforme as finalidades e os termos contratuais.

### 10.1 Documentação necessária

- inventário de dados pessoais;
- mapa de fluxos e compartilhamentos;
- base legal por finalidade;
- aviso de privacidade;
- termos de uso e contrato de assinatura;
- contrato ou DPA com o PSP;
- registro de suboperadores;
- avaliação de transferências internacionais;
- política de retenção e descarte;
- procedimento para solicitações de titulares;
- registro de operações de tratamento;
- relatório de impacto para tratamentos de maior risco;
- plano formal de resposta a incidentes.

### 10.2 Bases legais

Para cobrança, as bases legais mais prováveis são:

- execução de contrato;
- procedimentos preliminares relacionados ao contrato;
- cumprimento de obrigação legal ou regulatória para registros fiscais e contábeis;
- exercício regular de direitos em processos e disputas;
- legítimo interesse somente quando aplicável e devidamente avaliado.

Não é recomendável utilizar um consentimento genérico como base para todos os tratamentos.

### 10.3 Minimização e retenção

- Coletar apenas os dados necessários para a prestação e cobrança.
- Não duplicar no banco informações já mantidas pelo PSP sem necessidade.
- Definir prazos de retenção diferentes para dados operacionais, fiscais, de auditoria e suporte.
- Anonimizar ou excluir dados quando o prazo ou finalidade terminar.
- Manter registros sujeitos a obrigação legal mesmo após solicitação de exclusão, informando essa exceção ao titular.

### 10.4 Direitos dos titulares

O produto deve suportar processos para:

- confirmação de tratamento;
- acesso;
- correção;
- portabilidade;
- anonimização, bloqueio ou exclusão quando aplicável;
- informação sobre compartilhamentos;
- revogação de consentimento quando essa for a base utilizada;
- oposição ao tratamento;
- revisão de decisões automatizadas relevantes.

### 10.5 Incidentes de segurança

O plano de resposta deve incluir:

1. detecção e triagem;
2. preservação de evidências;
3. contenção;
4. avaliação dos dados e titulares afetados;
5. avaliação de risco ou dano relevante;
6. comunicação interna e jurídica;
7. notificação à ANPD e aos titulares quando necessária;
8. correção e acompanhamento pós-incidente.

De acordo com a regulamentação da ANPD, a comunicação à Agência e aos titulares, quando exigida, deve ocorrer em até três dias úteis.

Referências:

- [LGPD — ANPD](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/outros-documentos-e-publicacoes-institucionais/lgpd-en-lei-no-13-709-capa.pdf)
- [Comunicação de incidentes — ANPD](https://www.gov.br/anpd/pt-br/canais_atendimento/agente-de-tratamento/comunicado-de-incidente-de-seguranca-cis)

## 11. Compliance Comercial e Regulatório

Devem ser avaliados e documentados:

- preço total e periodicidade antes da contratação;
- meios de pagamento aceitos;
- regras de renovação automática;
- trial e data da primeira cobrança;
- condições de reajuste;
- cancelamento simples pelo próprio usuário;
- política de reembolso;
- tratamento de chargebacks;
- direito de arrependimento no comércio eletrônico;
- histórico e comprovantes de cobrança;
- suporte ao consumidor;
- registro das solicitações e cancelamentos;
- emissão de NFS-e.

O recibo emitido pelo PSP não substitui necessariamente a nota fiscal do serviço.

Se o produto cobrar apenas sua própria assinatura por meio de um PSP, normalmente não estará criando uma instituição de pagamento. Essa avaliação muda caso o produto passe a:

- custodiar dinheiro de usuários;
- criar carteira ou conta de pagamento;
- intermediar pagamentos de terceiros;
- realizar split;
- liquidar valores para terceiros;
- oferecer crédito ou outros serviços financeiros regulados.

Nesse cenário, será necessária análise jurídica e regulatória específica.

## 12. PSP Selecionado: Asaas

### 12.1 Decisão

O Asaas foi selecionado como PSP da primeira versão do Financial Vellun.

Fatores determinantes:

- suporte a assinatura recorrente por cartão;
- checkout hospedado com recorrência;
- operação, documentação e suporte orientados ao mercado brasileiro;
- sandbox para desenvolvimento;
- webhooks para acompanhar cobranças e assinaturas;
- suporte a cancelamento, estorno e chargeback;
- relatórios e recursos de conciliação;
- conformidade PCI DSS documentada;
- ausência de mensalidade ou taxa de adesão na oferta pública consultada;
- possibilidade de emissão de NFS-e e expansão futura para outros meios de pagamento.

### 12.2 Escopo contratado inicialmente

- moeda: BRL;
- meio de pagamento: cartão de crédito;
- modalidade: cobrança recorrente;
- periodicidade inicial: mensal e/ou anual, conforme os planos definidos;
- checkout: hospedado pelo Asaas;
- ativação: somente após confirmação de pagamento recebida por webhook ou reconciliação;
- split: fora do escopo;
- Pix, Pix Automático e boleto: fora do escopo;
- armazenamento de cartão no Financial Vellun: proibido.

### 12.3 Pontos que exigem confirmação comercial

Antes da entrada em produção, obter confirmação formal do Asaas sobre:

- taxas de cartão recorrente aplicáveis à conta;
- prazo de recebimento;
- regras e custos de antecipação;
- política e custo de chargeback;
- estratégia disponível para retentativas de cobranças recusadas;
- mecanismo para atualização do cartão de uma assinatura;
- SLA e canais de suporte;
- limites de requisição da API;
- procedimento para exportação de clientes, assinaturas e cobranças;
- possibilidade e condições de portabilidade dos tokens de cartão;
- DPA, suboperadores e localização ou transferência internacional dos dados;
- questionário PCI DSS aplicável ao Checkout Asaas escolhido.

Preços públicos devem ser tratados como referência, não como condição contratual permanente.

### 12.4 Particularidades da integração

- O plano comercial será mantido no banco do Financial Vellun.
- O Asaas manterá o cliente, a assinatura e as cobranças geradas por recorrência.
- A assinatura local não será ativada pelo redirecionamento do checkout.
- Cada evento de webhook será persistido e processado de forma idempotente.
- O webhook deve ser protegido pelo mecanismo de autenticação disponibilizado pelo Asaas.
- Após receber um evento crítico, a aplicação poderá consultar a API do Asaas para confirmar o estado atual antes de conceder ou revogar acesso.
- A reconciliação periódica deverá comparar assinaturas e cobranças locais com os dados do Asaas.
- O cancelamento local deverá interromper a geração de novas cobranças no Asaas e preservar a regra de acesso até o final do período já pago, quando aplicável.
- O tratamento de atualização de cartão dependerá do fluxo seguro oferecido pelo Asaas e nunca deverá solicitar dados completos do cartão ao backend.

Referências técnicas:

- [Asaas — Assinaturas](https://docs.asaas.com/docs/assinaturas)
- [Asaas — Checkout com assinatura recorrente](https://docs.asaas.com/docs/checkout-com-assinatura-recorrente)
- [Asaas — Webhooks](https://docs.asaas.com/docs/webhooks)
- [Asaas — PCI DSS](https://docs.asaas.com/docs/pci-dss-1)
- [Asaas — Preços e taxas](https://www.asaas.com/precos-e-taxas)

A camada de domínio não deve depender diretamente dos tipos do SDK do PSP.

Interface sugerida:

```typescript
interface PaymentProvider {
  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  createPaymentMethodUpdateSession(
    input: PaymentMethodUpdateInput,
  ): Promise<PaymentMethodUpdateSession>;
  cancelSubscription(input: CancelSubscriptionInput): Promise<void>;
  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscription>;
  listSubscriptionPayments(providerSubscriptionId: string): Promise<ProviderPayment[]>;
  refundPayment(input: RefundPaymentInput): Promise<ProviderRefund>;
  verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedPaymentEvent>;
}
```

O adapter `AsaasPaymentProvider` será o único módulo autorizado a utilizar diretamente o SDK ou os contratos HTTP do Asaas. Controllers, guards e serviços de domínio trabalharão apenas com os tipos internos acima.

## 13. Plano de Implementação

### Fase 1 — Decisões de produto e compliance

#### Tarefas

- Definir planos, preços e funcionalidades.
- Definir cobrança mensal e/ou anual.
- Definir período de teste.
- Definir janela de tolerância.
- Definir política de cancelamento e reembolso.
- Confirmar cartão de crédito como único meio de pagamento do MVP.
- Contratar e homologar a conta Asaas.
- Obter proposta comercial e documentos de compliance do Asaas.
- Revisar contratos, privacidade e obrigações fiscais.
- Definir quem pode realizar alterações manuais nas assinaturas.

#### Critério de conclusão

- Política comercial aprovada.
- Asaas contratado e conta aprovada para produção.
- Taxas, recebimento e suporte confirmados formalmente.
- Contratos e responsabilidades documentados.
- Estados e transições da assinatura definidos.

### Fase 2 — Fundação de billing

#### Tarefas

- Adicionar enums e modelos ao Prisma.
- Criar migration.
- Criar seed dos planos.
- Criar módulo `billing` no NestJS.
- Criar interface `PaymentProvider`.
- Criar serviço de estado da assinatura.
- Criar `SubscriptionAccessService`.
- Criar auditoria das transições.

#### Áreas esperadas

```text
apps/api/prisma/schema.prisma
apps/api/src/billing/
packages/shared/src/
```

#### Critério de conclusão

- É possível criar e consultar planos e assinaturas no banco.
- Transições inválidas são rejeitadas.
- O domínio não depende diretamente de um SDK específico.

### Fase 3 — Integração com o Asaas

#### Tarefas

- Implementar `AsaasPaymentProvider`.
- Configurar cliente HTTP, autenticação, timeout e retry seguro.
- Criar ou recuperar o cliente no Asaas.
- Criar Checkout Asaas com assinatura recorrente por cartão.
- Implementar o fluxo seguro de atualização do cartão disponibilizado pelo Asaas.
- Criar endpoint de webhook.
- Validar a autenticação do webhook conforme o mecanismo do Asaas.
- Persistir o identificador único de cada evento antes de processá-lo.
- Mapear eventos do Asaas para estados internos de assinatura e pagamento.
- Consultar a API do Asaas para confirmar eventos críticos quando necessário.
- Processar eventos de forma assíncrona.
- Implementar retry, backoff e DLQ.
- Criar rotina de reconciliação.
- Configurar variáveis como `ASAAS_API_URL`, `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN`.
- Manter credenciais e dados de sandbox separados de produção.

#### Critério de conclusão

- Checkout recorrente por cartão funciona no sandbox do Asaas.
- Pagamento aprovado ativa a assinatura.
- Evento duplicado não gera efeitos duplicados.
- Falha no processamento pode ser reexecutada.
- Pagamento recusado não concede acesso.
- Cancelamento interrompe futuras cobranças conforme a política definida.
- Divergências entre o banco local e o Asaas podem ser detectadas pela reconciliação.

### Fase 4 — Controle de acesso

#### Tarefas

- Criar `ActiveSubscriptionGuard`.
- Definir decorator para endpoints públicos ou permitidos sem assinatura.
- Proteger módulos de negócio.
- Proteger endpoints internos.
- Validar assinatura no fluxo de identificação por telefone.
- Interromper processamento do agente antes do LLM.
- Padronizar `SUBSCRIPTION_REQUIRED`.
- Definir comportamento durante grace period.

#### Critério de conclusão

- Usuário sem assinatura não consegue criar ou consultar dados de negócio.
- Usuário sem assinatura continua conseguindo acessar billing e privacidade.
- O canal de WhatsApp não cria lançamentos nem consome IA sem assinatura.
- O frontend não é a única camada de proteção.

### Fase 5 — Frontend

#### Tarefas

- Criar página de planos.
- Criar início do checkout.
- Criar páginas de retorno e cancelamento do checkout.
- Criar tela “Minha assinatura”.
- Exibir plano, status, próxima cobrança e cancelamento programado.
- Permitir atualização do cartão por um fluxo hospedado ou tokenizado pelo Asaas.
- Permitir cancelamento.
- Exibir avisos de pagamento recusado e grace period.
- Redirecionar erros `SUBSCRIPTION_REQUIRED` para a área de billing.
- Atualizar o contexto de autenticação com o estado de acesso.

#### Critério de conclusão

- Usuário consegue contratar, consultar e cancelar uma assinatura.
- Retorno visual não ativa a conta antes da confirmação do backend.
- Estados de loading, falha e inadimplência são tratados.

### Fase 6 — Segurança e privacidade

#### Tarefas

- Implementar CSRF.
- Implementar rate limiting.
- Configurar CSP e headers.
- Configurar gestão e rotação de segredos.
- Revisar logs.
- Implementar retenção e descarte.
- Criar exportação e exclusão de dados.
- Corrigir verificação de telefone.
- Criar plano de resposta a incidentes.
- Documentar responsabilidades com o PSP.
- Adicionar scanners de segurança no CI.

#### Critério de conclusão

- Nenhum dado completo de cartão passa pelo backend.
- Logs não contêm segredos ou dados de cartão.
- Solicitações de titulares têm fluxo definido.
- Existe procedimento documentado para incidentes.
- Existe evidência da análise PCI aplicável.

### Fase 7 — Testes e rollout

#### Cenários obrigatórios

- checkout concluído;
- checkout abandonado;
- pagamento recusado;
- webhook inválido;
- webhook duplicado;
- eventos fora de ordem;
- renovação aprovada;
- renovação recusada;
- grace period;
- expiração;
- cancelamento ao fim do período;
- cancelamento imediato autorizado;
- reembolso;
- chargeback;
- divergência entre banco e PSP;
- indisponibilidade temporária do PSP;
- usuário sem assinatura no web;
- usuário sem assinatura diretamente na API;
- usuário sem assinatura no WhatsApp;
- tentativa de acesso a dados de outro usuário.

#### Estratégia de rollout

1. ambiente local com mocks;
2. sandbox do Asaas;
3. ambiente de staging;
4. testes internos;
5. beta com poucos usuários;
6. produção com feature flag;
7. ativação progressiva da obrigatoriedade.

#### Monitoramento

- taxa de conversão;
- pagamentos aprovados e recusados;
- assinaturas `past_due`;
- falhas de webhook;
- tamanho da DLQ;
- divergências de reconciliação;
- chargebacks;
- cancelamentos;
- latência e erro dos endpoints do PSP;
- custo de IA bloqueado por falta de assinatura.

## 14. Estratégia de Testes

### Testes unitários

- máquina de estados da assinatura;
- cálculo de acesso;
- grace period;
- cancelamento programado;
- mapeamento dos eventos do PSP;
- sanitização de payload;
- idempotência.

### Testes de integração

- banco e migrations;
- endpoints de billing;
- webhook autenticado com o token configurado no Asaas;
- criação de checkout;
- processamento em fila;
- reconciliação;
- aplicação do guard.

### Testes end-to-end

- cadastro até ativação;
- inadimplência até bloqueio;
- regularização até reativação;
- cancelamento mantendo acesso até o fim;
- bloqueio consistente entre web, API e WhatsApp.

### Testes de segurança

- CSRF;
- replay de webhook;
- token de autenticação do webhook inválido;
- manipulação de `userId`;
- escalada de privilégio;
- vazamento de dados em logs;
- rate limiting;
- enumeração de clientes e assinaturas;
- acesso indevido a portal ou checkout de outro usuário.

## 15. Decisões e Pendências Antes da Implementação

Decisões tomadas:

- PSP: Asaas.
- Meio de pagamento do MVP: cartão de crédito.
- Modelo: assinatura recorrente.
- Moeda: BRL.
- Pix, Pix Automático, boleto e split: fora do escopo inicial.
- Dados completos de cartão não passarão pelo backend.

Pendências:

- Planos e valores.
- Cobrança mensal, anual ou ambas.
- Existência e duração do trial.
- Duração do grace period.
- Política de cancelamento.
- Política de reembolso.
- Comportamento em chargeback.
- Acesso somente leitura após cancelamento ou bloqueio total.
- Limites por plano.
- Processo de emissão fiscal.
- Responsável interno por privacidade e incidentes.
- Condições comerciais finais do Asaas.
- Fluxo definitivo de atualização de cartão.
- Estratégia de retentativa de cobranças recusadas.
- Eventos de webhook que serão tratados na primeira versão.
- Política de reconciliação com o Asaas.

## 16. Estimativa Inicial

Para um MVP com segurança e controles mínimos adequados:

```text
Fase 1: 3 a 5 dias
Fase 2: 4 a 6 dias
Fase 3: 6 a 10 dias
Fase 4: 3 a 5 dias
Fase 5: 4 a 7 dias
Fase 6: 5 a 8 dias
Fase 7: 4 a 7 dias
```

Estimativa total: aproximadamente quatro a seis semanas, dependendo da homologação da conta Asaas, da infraestrutura disponível e do grau de automação exigido.

Essa estimativa não inclui o tempo de revisão jurídica, homologação fiscal, contratação e aprovação da conta Asaas ou análise formal feita por assessor PCI.

## 17. Definition of Done

A funcionalidade poderá ser considerada pronta para produção quando:

- nenhum dado completo de cartão passar pela aplicação;
- a ativação depender de confirmação autenticada do PSP;
- webhooks forem validados e idempotentes;
- existir reconciliação periódica;
- o controle de acesso estiver centralizado na API;
- web, API e WhatsApp aplicarem a mesma regra de assinatura;
- usuários bloqueados ainda conseguirem acessar cobrança e privacidade;
- logs e auditorias permitirem investigar alterações;
- segredos estiverem fora do código;
- fluxos de cancelamento, inadimplência e reembolso estiverem documentados;
- os cenários críticos tiverem testes automatizados;
- os documentos de privacidade e termos estiverem atualizados;
- o enquadramento PCI tiver sido validado;
- o procedimento de resposta a incidentes estiver aprovado;
- monitoramento e alertas estiverem operacionais.
