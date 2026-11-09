# Plano — cadastro só com dados pessoais; CPF e endereço exigidos na assinatura

## Contexto

O cadastro tem duas etapas: "Seus dados" (nome, e-mail, WhatsApp, senha) e "Documento e endereço" (CPF, nascimento, CEP, logradouro, número, complemento, bairro, cidade, UF). A etapa 2 existe só para o Asaas: o endereço é usado unicamente ao criar o cliente no PSP (`billing.service.ts` → `AsaasPaymentProvider.createCustomer`), e cidade/UF nem são enviadas. Nenhuma outra parte do app usa esses dados.

Decisão do Bruno (19/10/2026): o cadastro fica só com a etapa 1. CPF e endereço continuam obrigatórios **para assinar** — mantidos por segurança, pelo risco de o cartão ser recusado sem endereço — e são preenchidos em "Minha Conta", que já tem todos os campos. Na tela de assinatura, as opções ficam bloqueadas, com um aviso no padrão do aviso de WhatsApp, até os dados estarem completos.

Ganho: a conta (com e-mail e WhatsApp verificado) existe antes do atrito; quem desiste no endereço deixa contato. A barreira para quem vai pagar não diminui — só muda de lugar.

Branch nova a partir da `main`, depois do merge do PR de billing (este plano depende de `requiredCustomerFields`, da entrega 5).

## Andamento

Implementado em 19/10/2026 no branch `feat/cadastro-simplificado`. Falta a verificação no sandbox do Asaas (item 4 da verificação).

Desvios em relação ao texto abaixo:

- **Minha Conta não mudou:** o bloco de endereço já dizia "Necessário para assinar um plano pago".
- **O aviso só aparece onde há checkout a abrir** (lista de planos ou "Regularizar pagamento"). Assinatura ativa com cadastro incompleto não mostra aviso.
- **`signup-step-account.tsx` virou `signup-fields.tsx`** (`SignupFields`): sem etapas, o nome não fazia mais sentido.
- **O rótulo do documento segue o tipo de conta** (CPF ou CNPJ) no aviso; na mensagem de erro da API continua "CPF/CNPJ".
- **`common/field-errors.spec.ts`** passou a usar um CEP inválido, e não ausente, para provar que o campo é apontado: ausente agora é válido.

## Regra única: "dados de cobrança completos"

Hoje a regra mora em `BillingService.assertBillingProfileComplete` (`apps/api/src/billing/billing.service.ts`) e só roda quando **não há cliente reaproveitável no PSP** (`current.provider === this.provider.name && current.providerCustomerId`). A tela precisa da mesma resposta, inclusive dessa exceção — senão bloquearia quem regulariza um pagamento atrasado e já tem cliente no Asaas. Por isso a pendência vem da API, não é recalculada no web.

## API

1. **`AsaasPaymentProvider.requiredCustomerFields`** (`providers/asaas/asaas-payment.provider.ts`): incluir `'document'`. Hoje o CPF fica fora porque o cadastro o garantia; sem ele, o Asaas recusa a criação do cliente. Cidade/UF continuam fora (o Asaas as deriva do CEP).

2. **`CustomerProfileField` vai para `@financial-vellun/shared`** (`packages/shared/src`), como foi feito com `PaymentFailureReason`; `payment-provider.interface.ts` passa a reexportá-lo. A web usa o tipo para rotular os campos.

3. **`BillingService`**: extrair de `assertBillingProfileComplete` uma função `missingBillingFields(user, current): CustomerProfileField[]`, que devolve `[]` quando há cliente reaproveitável no PSP configurado. Usada em dois lugares:
   - `createCheckout`: substitui o par "decide `providerCustomerId` + assert" mantendo a mesma ordem e a mesma mensagem de erro (última barreira para chamadas diretas à API). Ajustar o texto para "Complete seus dados de cobrança em "Minha Conta"…", já que inclui o CPF.
   - `getSubscriptionState`: novo campo `missingBillingFields: CustomerProfileField[]`. Carrega o usuário com `individualProfile`/`businessProfile` (mesma `include` do checkout). Documentar no Swagger se a resposta tiver DTO.

4. **Cadastro** (`apps/api/src/auth/dto/register.dto.ts`, `auth.service.ts`):
   - Endereço e `cpf` passam a `@IsOptional()`, mantendo `@Matches`/`@IsCpf` para quando vierem (compatível com um web antigo durante o deploy). PJ não muda: o cadastro público só cria PF.
   - `register`: só checa CPF duplicado e só cria `individualProfile` quando vier `cpf`. Endereço grava o que vier (colunas já aceitam nulo).
   - Comentário do schema Prisma sobre o endereço ("obrigatório em novos cadastros via DTO") atualizado; **sem migration**.

## Web

5. **Cadastro em uma etapa** (`apps/web/src/components/auth/`):
   - `signup-schema.ts`: sai tudo da etapa 2 (CPF, nascimento, endereço), `STEP_FIELDS`, `SIGNUP_STEPS`, `stepOf`, `SignupStep`; `FIELD_ORDER` vira a lista dos campos da etapa 1 (ainda usada por `api-errors.ts`); `toRegisterPayload` sem endereço/CPF.
   - `signup-form.tsx`: um formulário só, sem `StepIndicator`, "Continuar" e "Voltar"; o texto dos Termos e o botão "Criar conta" ficam abaixo dos campos. Foco no primeiro erro continua via `FIELD_ORDER`.
   - Remover `signup-step-details.tsx` e `step-indicator.tsx` (só usados aqui). `signup-step-account.tsx` permanece.
   - `lib/auth.ts`: tipo do `register` com endereço/CPF opcionais (ou removidos).
   - Redirecionamento pós-cadastro para `/app/verificar-whatsapp` não muda.

6. **Tela de assinatura** (`apps/web/src/app/app/conta/assinatura/page.tsx`, `lib/billing.ts`):
   - `SubscriptionState` ganha `missingBillingFields`.
   - Com pendência: aviso no topo, no mesmo estilo do `WhatsappBanner` (`app/app/layout.tsx`: caixa azul, texto + link), algo como _"Para assinar, complete seus dados de cobrança em Minha Conta: CPF, CEP, número."_ com link "Completar dados" para `/app/conta`. Rótulos em pt-BR num mapa local (telefone, CPF, CEP, logradouro, número, bairro).
   - Botões que abrem checkout ficam desabilitados com pendência: "Assinar" (`PlansList`) e "Regularizar pagamento" (`ManagementCard`). "Escolher plano de novo" só abre a lista, que já estará bloqueada.
   - Mobile first; o aviso não aparece em outras telas.

7. **Minha Conta** (`apps/web/src/app/app/conta/page.tsx`): campos e salvamento continuam como estão. Só um texto curto no bloco "Endereço de cobrança" (como o card "Documento" já tem): "Necessário para assinar." Nenhuma validação nova — o bloqueio está na assinatura.

## Testes

- `auth.service.spec.ts`: cadastro sem CPF nem endereço cria o usuário sem `individualProfile`; com CPF, mantém a checagem de duplicado.
- `billing.service.spec.ts`: `getSubscriptionState` devolve as pendências (CPF ausente, endereço ausente, completo → `[]`, cliente reaproveitável → `[]`); `createCheckout` continua recusando com a mensagem nova.
- `asaas-payment.provider.spec.ts`: `requiredCustomerFields` com `document`.

## Verificação

1. `pnpm --filter @financial-vellun/api test`, `pnpm lint`, `tsc` de API, web e shared, Prettier nos arquivos alterados.
2. API local: `POST /auth/register` só com nome, e-mail, WhatsApp e senha → 201; `GET /billing/subscription` → `missingBillingFields` com CPF e endereço; `POST /billing/checkout` → 400 com a mensagem; após `PATCH /users/me` + perfil PF → lista vazia.
3. Web com o roteiro de Puppeteer e API simulada (sem `next build` com o `next dev` aberto), em celular, tablet e desktop: cadastro de uma etapa (erros de campo e "E-mail já cadastrado" focando o campo), assinatura bloqueada com aviso, e liberada com dados completos.
4. Sandbox do Asaas: usuário novo completa os dados em Minha Conta, assina com o cartão de teste e o cliente aparece no Asaas com CPF e endereço.
