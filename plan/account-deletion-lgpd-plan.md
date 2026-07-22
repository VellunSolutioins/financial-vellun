# Plano de Implementacao - Exclusao de Conta e LGPD

## Contexto

O Financial Vellun trata dados pessoais e financeiros sensiveis para o usuario:

- dados cadastrais: nome, email, telefone, endereco;
- documentos: CPF ou CNPJ;
- dados financeiros: contas, categorias, lancamentos, contatos, saldos;
- dados de WhatsApp/IA: telefone, mensagens, transcricoes, entradas brutas e extracoes;
- dados de billing: assinatura, pagamentos, identificadores do Asaas e eventos de webhook.

A feature de exclusao de conta deve atender direitos do titular previstos na LGPD, especialmente acesso/exportacao, eliminacao, anonimização/bloqueio quando aplicavel, transparencia, minimizacao, seguranca e prestacao de contas.

Este plano nao substitui revisao juridica. Antes de producao, validar o fluxo com assessoria juridica e alinhar com a politica de privacidade, contratos com suboperadores e obrigacoes fiscais/contabeis.

Referencia principal: Lei 13.709/2018 - LGPD.

## Decisao Recomendada

Implementar uma abordagem hibrida:

1. Bloqueio logico imediato da conta.
2. Revogacao de sessoes e tokens.
3. Cancelamento da assinatura.
4. Exclusao fisica dos dados financeiros, WhatsApp e IA.
5. Anonimizacao ou retencao minima de registros estritamente necessarios para auditoria, billing, chargeback, obrigacao legal ou defesa em disputa.
6. Estatisticas apenas agregadas e anonimas, sem `userId`, email, telefone, CPF/CNPJ ou transacoes individuais.

Nao manter um "soft delete puro" com todos os lancamentos e mensagens associados ao usuario. Isso preserva dados pessoais demais sem finalidade clara e aumenta risco de privacidade.

## Escopo Funcional

### Exportacao de Dados

Criar um fluxo para o usuario exportar seus dados antes da exclusao.

Endpoint sugerido:

- `GET /privacy/export`

Conteudo minimo:

- dados da conta;
- perfil individual ou empresarial;
- endereco de cobranca;
- contas;
- categorias proprias;
- lancamentos;
- contatos;
- historico de assinatura e pagamentos;
- dados de WhatsApp/IA relacionados ao usuario, incluindo conversas, mensagens e extracoes, se ainda existirem;
- metadados basicos de solicitacoes de privacidade.

Formato:

- JSON estruturado no MVP;
- opcionalmente ZIP/CSV em fase posterior.

### Exclusao de Conta

Endpoint sugerido:

- `DELETE /users/me`

ou:

- `POST /privacy/account-deletion`

Requisitos:

- exigir senha atual ou reautenticacao recente;
- exigir confirmacao explicita na UI;
- bloquear a conta imediatamente;
- cancelar assinatura no provedor de pagamento;
- revogar sessoes e refresh tokens;
- excluir ou anonimizar dados conforme matriz de retencao;
- retornar resposta clara informando que a exclusao foi solicitada/concluida.

### Estado da Conta

Adicionar estado no usuario para bloquear acessos antes da limpeza definitiva:

- `active`;
- `deletion_requested`;
- `deleted`.

Campos sugeridos:

- `status`;
- `deletionRequestedAt`;
- `deletedAt`;
- `anonymizedAt`.

Os guards de autenticacao devem rejeitar usuarios em `deletion_requested` ou `deleted`.

## Modelagem Prisma

### Alteracoes em `User`

Adicionar:

- `status UserStatus @default(active)`;
- `deletionRequestedAt DateTime? @map("deletion_requested_at")`;
- `deletedAt DateTime? @map("deleted_at")`;
- `anonymizedAt DateTime? @map("anonymized_at")`.

Criar enum:

- `UserStatus`: `active`, `deletion_requested`, `deleted`.

### Solicitacoes de Privacidade

Criar model `PrivacyRequest`:

- `id`;
- `userId`;
- `type`: `export`, `delete_account`;
- `status`: `requested`, `processing`, `completed`, `failed`;
- `requestedAt`;
- `completedAt`;
- `failureReason`;
- `metadata`.

Se a conta for excluida fisicamente, avaliar manter `userId` nullable ou registrar apenas identificador anonimizado/hash nao reversivel.

### Estatisticas Anonimas

Opcional para analytics futuro:

- `DeletedAccountStats`;
- mes/ano da exclusao;
- tipo de perfil;
- idade da conta em dias;
- contagem agregada de transacoes;
- totais agregados sem granularidade suficiente para reidentificacao.

Nao armazenar:

- email;
- telefone;
- nome;
- documento;
- endereco;
- transacoes individuais;
- descricoes;
- `rawInput`;
- identificadores externos diretamente vinculaveis.

## Matriz de Tratamento dos Dados

### Apagar

Dados que devem ser excluidos definitivamente no banco primario:

- `Account`;
- `Category` propria do usuario;
- `Transaction`;
- `Contact`;
- `IndividualProfile`;
- `BusinessProfile`;
- `WhatsappContact`;
- `AiConversation`;
- `AiMessage`;
- `AiExtractedTransaction`;
- `Transaction.rawInput`;
- qualquer buffer/DLQ de WhatsApp/IA relacionado ao telefone do usuario.

Observacao: o schema atual ja usa `onDelete: Cascade` em varias relacoes financeiras, mas conversas/mensagens de WhatsApp podem sobreviver por relacoes `SetNull`. O fluxo de exclusao deve tratar explicitamente WhatsApp/IA antes ou durante a exclusao da conta.

### Anonimizar ou Reter Minimamente

Dados que podem exigir retencao limitada:

- `Subscription`;
- `Payment`;
- `SubscriptionAudit`;
- `PaymentWebhookEvent`;
- identificadores do Asaas.

Regra:

- manter apenas quando houver base legal clara, obrigacao operacional, fiscal, chargeback, antifraude ou defesa em disputa;
- remover PII dos payloads e metadados;
- substituir dados identificadores por marcador anonimo;
- documentar prazo de retencao.

### Apagar/Anonimizar no Provedor Externo

No Asaas:

- cancelar assinatura;
- verificar disponibilidade de exclusao ou anonimização do cliente;
- se o PSP exigir retencao, documentar no aviso de privacidade.

Na OpenAI/LLM e WhatsApp/Meta:

- documentar suboperadores;
- minimizar dados enviados;
- nao enviar documentos, endereco ou dados desnecessarios ao LLM;
- registrar politica de retencao aplicavel.

## Backend

### Novo Modulo `privacy`

Arquivos sugeridos:

- `apps/api/src/privacy/privacy.module.ts`;
- `apps/api/src/privacy/privacy.controller.ts`;
- `apps/api/src/privacy/privacy.service.ts`;
- `apps/api/src/privacy/dto/delete-account.dto.ts`;
- `apps/api/src/privacy/dto/export-data.dto.ts`.

Responsabilidades:

- exportar dados do titular;
- validar confirmacao de exclusao;
- criar `PrivacyRequest`;
- orquestrar exclusao/anonimizacao;
- cancelar billing;
- limpar WhatsApp/IA;
- registrar resultado da operacao.

### Sequencia de Exclusao

1. Validar usuario autenticado.
2. Validar senha atual ou reautenticacao recente.
3. Criar `PrivacyRequest` do tipo `delete_account`.
4. Atualizar `User.status = deletion_requested`.
5. Revogar sessoes/refresh tokens.
6. Cancelar assinatura no Asaas, se existir.
7. Gerar estatisticas anonimas opcionais.
8. Excluir WhatsApp/IA:
   - mensagens;
   - conversas;
   - extracoes;
   - contato WhatsApp;
   - buffers/DLQ, quando aplicavel.
9. Excluir dados financeiros e perfis:
   - lancamentos;
   - contas;
   - categorias proprias;
   - contatos;
   - perfis PF/PJ.
10. Anonimizar billing/auditoria retidos.
11. Anonimizar ou remover `User`.
12. Marcar `PrivacyRequest` como concluida.
13. Limpar cookies na resposta.

### Transacao e Job Assincrono

Para o MVP, a exclusao pode ser sincrona se o volume for pequeno.

Para producao, preferir:

- endpoint marca `deletion_requested`;
- job assíncrono processa a limpeza;
- estado consultavel pelo usuario enquanto ainda estiver logado ou por email transacional;
- retry seguro e idempotente.

O job deve ser idempotente: rodar duas vezes nao deve recriar nem falhar por registros ja apagados.

## Autenticacao e Sessao

Hoje os refresh tokens sao JWT stateless em cookie. Para revogacao forte, implementar store de refresh token:

- model `RefreshToken`;
- hash do token;
- `expiresAt`;
- `revokedAt`;
- `replacedById`;
- rotacao a cada refresh;
- revogacao no logout e na exclusao de conta;
- deteccao de replay.

Enquanto isso nao existir:

- `JwtStrategy` e `JwtRefreshStrategy` devem buscar o usuario e rejeitar `status != active`;
- `AuthService.login` deve rejeitar usuarios deletados;
- `AuthService.refresh` deve rejeitar usuarios deletados;
- `AuthController.logout` deve limpar cookies apos exclusao.

## Frontend

### Minha Conta

Adicionar area "Privacidade e dados" em `apps/web/src/app/app/conta/page.tsx`.

Controles:

- botao "Exportar meus dados";
- botao destrutivo "Excluir minha conta";
- modal de confirmacao;
- campo de senha atual;
- texto claro informando que conta, lancamentos, contatos e dados de WhatsApp/IA serao removidos;
- feedback de loading, sucesso e erro.

Depois da exclusao:

- chamar logout/limpar contexto;
- redirecionar para login;
- exibir mensagem de conta excluida.

## WhatsApp e IA

Pontos a tratar:

- `WhatsappContact.phoneNumber` identifica o usuario mesmo sem `userId`;
- `AiMessage.content` pode conter despesas, renda, documentos e detalhes pessoais;
- `AiExtractedTransaction.rawInput` e `Transaction.rawInput` podem duplicar a mensagem original;
- Redis/DLQ do agente pode conter telefone e conteudo da mensagem.

Acoes:

- apagar conversas e mensagens antes de remover ou anonimizar o usuario;
- remover `WhatsappContact` ou anonimizar `phoneNumber`;
- limpar pendencias de processamento por telefone;
- mascarar telefone em logs de producao;
- revisar mensagens enviadas ao LLM para minimizacao.

## Billing e Asaas

Fluxo:

1. Buscar assinatura atual.
2. Se houver `providerSubscriptionId`, cancelar no Asaas.
3. Se houver `providerCustomerId`, tentar anonimizar/remover cliente externo se o provedor suportar.
4. Anonimizar registros retidos no banco:
   - remover metadados com PII;
   - preservar status, valores, datas e ids estritamente necessarios;
   - evitar email, telefone, documento e endereco.

O sistema ja evita trafego de dados de cartao pelo backend e sanitiza payloads de webhook, mas a politica de retencao de `PaymentWebhookEvent.sanitizedPayload` e `SubscriptionAudit.metadata` precisa ser explicita.

## Outros Pontos de Privacidade e Seguranca

### OTP de Telefone

Risco atual: cadastro e edicao de telefone marcam `WhatsappContact.isVerified = true` sem confirmacao real.

Plano:

- gerar OTP com expiracao;
- armazenar hash do OTP;
- aplicar rate limit;
- enviar por WhatsApp/SMS;
- so marcar `isVerified = true` apos confirmacao;
- exigir reverificacao ao trocar telefone.

### Logs com PII

Revisar logs da API e do agente:

- nao logar telefone completo;
- nao logar mensagem completa do usuario em producao;
- nao logar payloads de PSP sem sanitizacao;
- manter correlation ids sem PII;
- mascarar documentos e emails.

### LLM e Suboperadores

Documentar:

- quais dados podem ser enviados ao provedor de IA;
- finalidade;
- base legal;
- tempo de retencao;
- suboperadores;
- como o usuario pode exercer direitos.

### Backups

Politica:

- excluir do banco primario imediatamente;
- backups seguem retencao definida;
- restauracoes devem reexecutar ou respeitar lista de exclusoes;
- documentar prazo maximo para desaparecimento de backups.

### CI e Seguranca

Adicionar:

- secret scanning;
- dependency audit Node/Python;
- SAST;
- testes de manipulacao de `userId`;
- testes de CSRF/rate limit em rotas sensiveis.

## Testes

### Unitarios

- exportacao contem todos os dados esperados do usuario;
- exportacao nao inclui dados de outro usuario;
- exclusao exige senha atual;
- usuario deletado nao consegue login/refresh;
- estrategia JWT rejeita usuario `deletion_requested` ou `deleted`;
- limpeza de WhatsApp/IA remove mensagens e extracoes;
- billing retido fica anonimizado.

### Integracao

- criar usuario completo com transacoes, contatos, WhatsApp, IA e billing;
- chamar exportacao;
- solicitar exclusao;
- verificar que dados financeiros foram apagados;
- verificar que telefone/email/documento nao ficam reutilizaveis de forma bloqueada;
- verificar que novo cadastro pode reutilizar email/telefone se a politica permitir;
- verificar cancelamento da assinatura;
- verificar cookies limpos.

### E2E Manual

1. Criar conta.
2. Criar lancamentos e contatos.
3. Vincular WhatsApp e gerar mensagens.
4. Criar assinatura sandbox.
5. Exportar dados.
6. Excluir conta.
7. Tentar login.
8. Conferir banco.
9. Conferir Asaas sandbox.
10. Criar nova conta com mesmo email/telefone, se permitido pela politica.

## Sequenciamento Sugerido

### PR 1 - Backend LGPD

- migration Prisma;
- modulo `privacy`;
- exportacao;
- exclusao/anonimizacao;
- guards rejeitando usuario deletado;
- testes unitarios e de integracao.

### PR 2 - Frontend

- area "Privacidade e dados";
- exportacao;
- modal de exclusao;
- limpeza de sessao e redirect.

### PR 3 - Hardening

- refresh token store e rotacao;
- OTP de telefone;
- limpeza/mascara de logs;
- limpeza de Redis/DLQ;
- scanners no CI;
- documentacao de retencao e incidentes.

## Criterios de Aceite

- Usuario consegue exportar os proprios dados.
- Usuario consegue excluir a conta apos confirmacao forte.
- Usuario deletado nao consegue login nem refresh.
- Lancamentos, contas, categorias proprias, contatos, mensagens IA/WhatsApp e raw inputs sao removidos.
- Registros mantidos para billing/auditoria nao contem PII desnecessaria.
- Assinatura no provedor e cancelada.
- Email/telefone/documento deixam de bloquear novo cadastro, conforme politica definida.
- Rotas de privacidade funcionam mesmo sem assinatura ativa.
- Testes cobrem isolamento por `userId`.
- Politica de privacidade e retencao descreve o comportamento real do sistema.
