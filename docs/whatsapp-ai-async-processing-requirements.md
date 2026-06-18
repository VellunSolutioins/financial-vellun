# Requisitos: Processamento Assíncrono de Mensagens WhatsApp com Contexto de IA

## 1. Objetivo

Implementar uma camada robusta de ingestão, agrupamento, persistência e processamento assíncrono de mensagens recebidas via WhatsApp, permitindo que o agente de IA:

- receba mensagens de múltiplos usuários simultaneamente;
- identifique cada conversa pelo número de telefone;
- agrupe mensagens enviadas em sequência curta antes de processar;
- consulte histórico recente da conversa antes de chamar a IA;
- localize o usuário vinculado ao telefone;
- extraia intenções financeiras com contexto suficiente;
- crie lançamentos, peça confirmação ou responda ao usuário;
- preserve rastreabilidade completa das mensagens, extrações e lançamentos.

O fluxo deve evitar tratar cada mensagem isolada como um comando independente, pois no WhatsApp é comum o usuário quebrar uma instrução em várias mensagens curtas.

Exemplo:

```txt
Usuário: gastei
Usuário: 47,50
Usuário: no mercado
```

O sistema deve processar como uma única entrada consolidada:

```txt
gastei
47,50
no mercado
```

Além disso, a IA deve conseguir usar histórico recente:

```txt
Usuário: gastei 100 no mercado
IA: Em qual conta devo registrar?
Usuário: Nubank
```

Nesse caso, a mensagem "Nubank" só faz sentido com base no contexto anterior.

## 2. Estado Atual Identificado

O projeto já possui parte importante da base:

- `apps/ai-agent` expõe `POST /webhook/whatsapp`.
- O webhook valida assinatura, parseia payload e processa a mensagem.
- O agente consulta a API principal para localizar o contato pelo telefone.
- O agente busca categorias e contas do usuário.
- O agente possui `IntentClassifier`, com suporte a provider LLM e fallback por regras.
- O agente possui `ConversationManager` em memória para intenções pendentes de confirmação.
- A API possui modelos Prisma para:
  - `WhatsappContact`;
  - `AiConversation`;
  - `AiMessage`;
  - `AiExtractedTransaction`.
- A API possui endpoint interno para gravar eventos de mensagem e extração.
- A criação de transação via IA já existe em `/internal/transactions/from-ai`.

O que ainda não existe:

- buffer/debounce de mensagens por telefone;
- fila ou worker assíncrono;
- resposta imediata do webhook antes do processamento completo;
- consulta das últimas mensagens da conversa para compor contexto;
- uso sistemático de histórico no prompt da IA;
- mecanismo persistente de estado para múltiplas instâncias;
- controle explícito de idempotência por `message_id`;
- estratégia de concorrência por telefone;
- observabilidade do pipeline assíncrono.

## 3. Escopo Funcional

### 3.1 Recebimento de Mensagens

O endpoint de WhatsApp deve receber payloads contendo, no mínimo:

```json
{
  "phone": "+5511999999999",
  "message": "gastei 47,50 no mercado",
  "timestamp": 1710000000,
  "message_id": "provider-message-id"
}
```

Requisitos:

- validar assinatura do webhook quando `WHATSAPP_WEBHOOK_SECRET` estiver configurado;
- rejeitar payload inválido com HTTP 400;
- rejeitar assinatura inválida com HTTP 401;
- normalizar o telefone antes de usar como chave lógica;
- salvar a mensagem inbound no histórico;
- adicionar a mensagem ao buffer de processamento do telefone;
- responder rapidamente ao provedor com HTTP 200, sem esperar a IA terminar;
- não criar lançamento diretamente dentro do request HTTP do webhook.

### 3.2 Persistência de Mensagens

Toda mensagem recebida deve ser persistida antes de ser processada pela IA.

Cada mensagem inbound deve ser associada a:

- telefone normalizado;
- `WhatsappContact`;
- `AiConversation` ativa;
- direção `inbound`;
- conteúdo original;
- `message_id` do provedor, quando disponível;
- timestamp do provedor, quando disponível;
- metadata do provedor, quando disponível;
- data/hora de recebimento no sistema.

Mensagens outbound também devem ser persistidas com:

- conversa;
- direção `outbound`;
- conteúdo enviado;
- metadata relevante;
- data/hora de envio.

Motivo: o histórico persistido é a fonte de contexto da IA e também serve para auditoria, debug e evolução futura.

### 3.3 Identificação por Telefone

O telefone é a chave primária operacional para o fluxo de WhatsApp.

Requisitos:

- todo processamento deve ser separado por telefone;
- mensagens de telefones diferentes não podem compartilhar buffer;
- mensagens de telefones diferentes podem ser processadas em paralelo;
- mensagens do mesmo telefone devem preservar ordem;
- o vínculo entre telefone e usuário deve ser consultado na API principal;
- se o telefone não estiver vinculado, o sistema deve responder com mensagem orientando o vínculo no app;
- se o telefone existir em `WhatsappContact`, mas não possuir `userId`, o fluxo deve tratar como não vinculado.

### 3.4 Buffer Curto com Debounce

O sistema deve manter um buffer temporário por telefone para agrupar mensagens enviadas em sequência.

Objetivo:

- evitar processar mensagens parciais;
- reduzir chamadas desnecessárias à IA;
- melhorar interpretação de mensagens quebradas.

Comportamento esperado:

1. Primeira mensagem de um telefone chega.
2. Sistema salva no banco.
3. Sistema adiciona ao buffer do telefone.
4. Sistema agenda processamento para depois de uma janela curta, por exemplo, 5 segundos.
5. Se novas mensagens do mesmo telefone chegarem antes da janela expirar, elas entram no mesmo buffer.
6. Quando a janela expira sem novas mensagens, o sistema consolida as mensagens e envia para processamento.

Exemplo:

```txt
t=0s  "gastei"
t=2s  "47 reais"
t=4s  "no mercado"
t=9s  processa "gastei\n47 reais\nno mercado"
```

Configurações recomendadas:

```env
MESSAGE_BUFFER_DEBOUNCE_SECONDS=5
MESSAGE_BUFFER_MAX_MESSAGES=10
MESSAGE_BUFFER_MAX_AGE_SECONDS=30
```

Regras:

- o debounce deve ser por telefone;
- nova mensagem do mesmo telefone deve reagendar o processamento;
- mensagens de outro telefone não devem interferir;
- o buffer deve respeitar limite máximo de mensagens;
- o buffer deve respeitar tempo máximo absoluto para evitar espera indefinida;
- ao processar, o buffer daquele telefone deve ser limpo de forma atômica;
- em caso de falha no processamento, o sistema deve registrar erro e decidir se reprocessa ou marca como falho.

### 3.5 Processamento Assíncrono

O processamento de IA deve ocorrer fora do ciclo principal do webhook.

O webhook deve fazer apenas:

- validar;
- persistir;
- enfileirar/bufferizar;
- responder ao provedor.

O worker/processador deve fazer:

- consolidar mensagens do buffer;
- localizar contato/usuário;
- carregar histórico recente;
- carregar categorias e contas;
- chamar classificador/LLM;
- decidir confirmação ou criação;
- criar lançamento quando aplicável;
- enviar resposta;
- persistir mensagem outbound;
- registrar extração e rastreabilidade.

Para MVP local, pode ser usado:

- `asyncio.create_task`;
- estrutura em memória por telefone;
- lock por telefone.

Para produção, deve ser considerado:

- Redis para buffer/debounce;
- fila com retry, backoff e DLQ;
- worker separado;
- idempotência por mensagem;
- lock distribuído por telefone;
- persistência do estado de jobs.

### 3.6 Histórico Conversacional

Antes de chamar a IA, o agente deve buscar histórico recente da conversa.

Requisito mínimo:

- buscar as últimas 15 mensagens da conversa ativa do telefone.

Configuração recomendada:

```env
CONVERSATION_CONTEXT_MESSAGE_LIMIT=15
```

O histórico deve conter:

```json
[
  {
    "direction": "inbound",
    "content": "gastei 100 no mercado",
    "createdAt": "2026-06-18T10:00:00.000Z"
  },
  {
    "direction": "outbound",
    "content": "Em qual conta devo registrar?",
    "createdAt": "2026-06-18T10:00:03.000Z"
  },
  {
    "direction": "inbound",
    "content": "Nubank",
    "createdAt": "2026-06-18T10:00:10.000Z"
  }
]
```

O histórico deve ser usado para:

- entender confirmações;
- entender respostas curtas;
- interpretar correções;
- evitar lançamentos duplicados;
- preservar continuidade de conversa.

O histórico não deve substituir a mensagem atual. A mensagem consolidada atual deve ter prioridade.

### 3.7 Contexto Enviado para IA

O classificador de intenção deve receber:

```python
{
    "today": "2026-06-18",
    "profile_type": "individual",
    "categories": ["Mercado", "Alimentação", "Transporte"],
    "accounts": ["Nubank", "Itaú", "Carteira"],
    "recent_messages": [
        {"direction": "inbound", "content": "...", "created_at": "..."},
        {"direction": "outbound", "content": "...", "created_at": "..."}
    ],
    "current_message": "mensagem consolidada atual"
}
```

O prompt da IA deve orientar:

- a mensagem atual é a principal fonte da ação;
- o histórico deve ser usado somente como contexto;
- não criar lançamento duplicado para algo já confirmado;
- quando a mensagem atual for resposta curta, inferir a que pergunta ela responde;
- se faltar informação essencial, pedir confirmação;
- se houver ambiguidade relevante, não criar lançamento automaticamente;
- escolher categoria e conta somente entre as opções disponíveis;
- usar data atual fornecida para resolver "hoje", "ontem", "anteontem";
- retornar sempre um objeto estruturado compatível com `FinancialIntent`.

### 3.8 Confirmações e Pendências

O sistema atual possui `ConversationManager` em memória para `pending_intent`.

Requisito:

- manter suporte a confirmação;
- usar histórico persistido para complementar a interpretação;
- não depender exclusivamente de estado em memória no médio prazo.

Exemplo:

```txt
Usuário: paguei 300
IA: Em qual categoria devo registrar?
Usuário: internet
```

O sistema deve completar a intenção pendente e criar o lançamento.

Comportamentos esperados:

- respostas afirmativas confirmam intenção pendente;
- respostas negativas cancelam intenção pendente;
- respostas com dados complementares preenchem campos faltantes;
- se ainda faltar campo essencial, nova pergunta deve ser enviada;
- pendências devem expirar após TTL configurável.

Configuração atual relacionada:

```env
CONVERSATION_TTL_MINUTES=30
```

### 3.9 Criação de Lançamento

Após extração confirmada, o sistema deve criar lançamento via API interna.

Payload esperado:

```json
{
  "userId": "uuid",
  "accountId": "uuid",
  "categoryId": "uuid",
  "type": "expense",
  "amount": 47.5,
  "description": "mercado",
  "transactionDate": "2026-06-18",
  "status": "confirmed",
  "source": "ai",
  "rawInput": "gastei 47,50 no mercado",
  "aiExtractedTransactionId": "uuid"
}
```

Regras:

- conta deve pertencer ao usuário;
- categoria deve ser padrão compatível ou pertencer ao usuário;
- transação confirmada deve recalcular saldo;
- extração deve ser vinculada à transação criada;
- em caso de falha, usuário deve receber resposta clara;
- falhas não devem derrubar o worker inteiro.

### 3.10 Mensagens de Resposta

Toda resposta enviada ao usuário deve:

- ser enviada pelo provedor/messenger;
- ser salva como `AiMessage` outbound;
- estar associada à mesma conversa;
- ser curta e objetiva.

Exemplos:

```txt
Lançamento criado! Despesa de R$ 47,50 em Mercado em 18/06/2026.
```

```txt
Em qual categoria devo registrar?
```

```txt
Seu número não está vinculado a uma conta. Acesse o app para vincular.
```

## 4. Requisitos de API Interna

### 4.1 Buscar Contato por Telefone

Já existe:

```http
GET /internal/whatsapp/contacts/:phone
```

Deve retornar:

```json
{
  "userId": "uuid",
  "name": "Bruno",
  "profileType": "individual",
  "isVerified": true
}
```

### 4.2 Registrar Evento de Mensagem

Já existe:

```http
POST /internal/ai-events
```

Uso atual:

```json
{
  "eventType": "message",
  "phone": "+5511999999999",
  "direction": "inbound",
  "content": "gastei 47,50 no mercado",
  "metadata": {
    "messageId": "provider-message-id",
    "timestamp": 1710000000
  }
}
```

Melhorias recomendadas:

- persistir `providerMessageId` em campo dedicado ou garantir metadata indexável;
- retornar `conversationId`;
- retornar `messageId`;
- tratar idempotência por `providerMessageId`.

### 4.3 Buscar Histórico de Conversa

Novo endpoint recomendado:

```http
GET /internal/whatsapp/contacts/:phone/messages?limit=15
```

Alternativa:

```http
GET /internal/ai-conversations/by-phone/:phone/messages?limit=15
```

Resposta:

```json
{
  "conversationId": "uuid",
  "messages": [
    {
      "id": "uuid",
      "direction": "inbound",
      "content": "gastei 100 no mercado",
      "metadata": {},
      "createdAt": "2026-06-18T10:00:00.000Z"
    }
  ]
}
```

Requisitos:

- normalizar telefone;
- localizar `WhatsappContact`;
- localizar conversa ativa mais recente;
- retornar últimas N mensagens ordenadas cronologicamente;
- limitar `limit` máximo para evitar payload excessivo;
- retornar lista vazia se não houver conversa.

### 4.4 Listar Categorias

Já existe:

```http
GET /internal/users/:userId/categories
```

Uso:

- fornecer opções válidas para IA;
- resolver `category_name` retornado pela IA para `categoryId`.

### 4.5 Listar Contas

Já existe:

```http
GET /internal/users/:userId/accounts
```

Uso:

- fornecer opções válidas para IA;
- resolver `account_name` retornado pela IA para `accountId`;
- usar primeira conta ativa como fallback quando nenhuma conta for citada.

### 4.6 Criar Transação da IA

Já existe:

```http
POST /internal/transactions/from-ai
```

Deve continuar validando:

- usuário;
- conta;
- categoria;
- tipo;
- valor positivo;
- data;
- origem.

## 5. Requisitos de Dados

### 5.1 WhatsappContact

Uso esperado:

- um registro por telefone;
- telefone normalizado e único;
- vínculo opcional com usuário;
- indicação de verificação.

Possíveis melhorias:

- armazenar data de último recebimento;
- armazenar provedor;
- armazenar status do vínculo;
- armazenar opt-in/opt-out.

### 5.2 AiConversation

Uso esperado:

- agrupar mensagens de um contato;
- manter conversa ativa;
- associar conversa ao usuário quando vinculado;
- atualizar `lastMessageAt` a cada mensagem.

Regras:

- deve haver no máximo uma conversa ativa principal por contato em uso normal;
- se conversa expirar por TTL, pode ser marcada como `completed` ou `abandoned`;
- nova mensagem após expiração pode criar nova conversa.

### 5.3 AiMessage

Uso esperado:

- persistir todas as mensagens inbound/outbound;
- preservar ordem temporal;
- armazenar metadata do provedor;
- servir como fonte de contexto para IA.

Melhorias recomendadas:

- adicionar campo `providerMessageId String? @unique`;
- adicionar campo `providerTimestamp DateTime?`;
- adicionar índices por `conversationId` e `createdAt`;
- considerar campo `processedAt` para inbound, se necessário.

### 5.4 AiExtractedTransaction

Uso esperado:

- armazenar payload extraído pela IA;
- armazenar confiança;
- armazenar status;
- vincular mensagem origem;
- vincular transação criada.

Regras:

- extração pendente deve ser criada quando faltar confirmação;
- extração confirmada deve ser vinculada à transação;
- extração rejeitada deve ser marcada quando usuário cancelar.

## 6. Requisitos de Concorrência

### 6.1 Separação por Telefone

Mensagens de usuários diferentes devem ser processadas independentemente.

Exemplo:

```txt
Telefone A: gastei 50 no uber
Telefone B: recebi 1000 do cliente
Telefone A: ontem
```

O buffer de A deve conter apenas mensagens de A.
O buffer de B deve conter apenas mensagens de B.

### 6.2 Ordem por Telefone

Para um mesmo telefone:

- preservar ordem de chegada;
- evitar dois processamentos simultâneos do mesmo buffer;
- evitar criar dois lançamentos para o mesmo conjunto de mensagens.

Implementação MVP:

- lock em memória por telefone.

Implementação produção:

- lock distribuído por telefone;
- job key por telefone;
- idempotência por `message_id`.

### 6.3 Idempotência

O provedor WhatsApp pode reenviar webhooks.

Requisitos:

- se `message_id` já foi recebido, não duplicar mensagem;
- se mensagem já foi processada, não reprocessar;
- se transação já foi criada para a extração, não criar novamente.

Estratégias:

- índice único em `providerMessageId`;
- metadata com `message_id` enquanto campo dedicado não existir;
- tabela ou cache de deduplicação;
- status de processamento por mensagem ou job.

## 7. Requisitos de Configuração

Variáveis recomendadas para `apps/ai-agent/.env`:

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

MESSAGE_BUFFER_DEBOUNCE_SECONDS=5
MESSAGE_BUFFER_MAX_MESSAGES=10
MESSAGE_BUFFER_MAX_AGE_SECONDS=30

CONVERSATION_CONTEXT_MESSAGE_LIMIT=15
CONVERSATION_TTL_MINUTES=30

MAIN_API_URL=http://localhost:3001
INTERNAL_API_KEY=super-secret-internal-api-key-for-ai-agent

WHATSAPP_WEBHOOK_SECRET=
WHATSAPP_PROVIDER_TOKEN=
```

Novos campos necessários em `Settings` do agente:

```python
message_buffer_debounce_seconds: int = 5
message_buffer_max_messages: int = 10
message_buffer_max_age_seconds: int = 30
conversation_context_message_limit: int = 15
```

## 8. Arquitetura Recomendada

### 8.1 MVP Local

Componentes:

- `WebhookRouter`;
- `MessageBufferService`;
- `ConversationHistoryService`;
- `MessageProcessor`;
- `IntentClassifier`;
- `TransactionCreator`;
- `Messenger`;
- `AuditService`.

Fluxo:

```txt
Webhook
  -> valida
  -> salva inbound
  -> adiciona ao MessageBufferService por phone
  -> agenda task com debounce
  -> responde 200

MessageBufferService
  -> aguarda debounce
  -> consolida mensagens do phone
  -> chama MessageProcessor

MessageProcessor
  -> localiza contato
  -> busca histórico
  -> busca contas/categorias
  -> chama IA
  -> cria lançamento ou pergunta confirmação
  -> envia resposta
  -> salva outbound
```

Vantagens:

- rápido de implementar;
- suficiente para desenvolvimento;
- baixa complexidade operacional.

Limitações:

- perde buffer em restart;
- não suporta múltiplas instâncias corretamente;
- retry limitado;
- observabilidade menor.

### 8.2 Produção

Componentes adicionais:

- Redis;
- fila de jobs;
- worker separado;
- retry/backoff;
- dead-letter queue;
- locks distribuídos;
- métricas.

Fluxo:

```txt
Webhook
  -> valida
  -> salva inbound
  -> escreve em Redis buffer:{phone}
  -> agenda job debounce:{phone}
  -> responde 200

Worker
  -> pega lock:{phone}
  -> lê buffer:{phone}
  -> consolida mensagens
  -> limpa buffer
  -> processa
  -> libera lock
```

## 9. Mudanças Esperadas no AI Agent

### 9.1 `webhook.py`

Alterar responsabilidade:

De:

```python
reply = await _process_message(payload)
await messenger.send(payload.phone, reply)
return {"status": "ok", "reply": reply}
```

Para:

```python
message_id = await inbound_message_service.save(payload)
await message_buffer.add(payload.phone, payload.message, message_id)
return {"status": "accepted"}
```

Observação:

- em ambiente de teste pode ser útil retornar informações de debug;
- em produção, o provedor normalmente só precisa de HTTP 200.

### 9.2 Novo `message_buffer.py`

Responsabilidades:

- armazenar mensagens temporárias por telefone;
- reagendar debounce;
- consolidar mensagens;
- chamar processador;
- aplicar lock por telefone.

Interface sugerida:

```python
class MessageBuffer:
    async def add(self, phone: str, message: str, source_message_id: str | None) -> None:
        ...
```

Estado sugerido para MVP:

```python
@dataclass
class BufferedMessage:
    content: str
    source_message_id: str | None
    received_at: datetime

@dataclass
class PhoneBuffer:
    messages: list[BufferedMessage]
    task: asyncio.Task | None
    first_message_at: datetime
    last_message_at: datetime
```

### 9.3 Novo `message_processor.py`

Responsabilidades:

- receber mensagem consolidada;
- executar lógica que hoje está em `_process_message`;
- usar histórico de conversa;
- enviar resposta;
- registrar outbound.

Interface sugerida:

```python
class MessageProcessor:
    async def process_buffered_message(
        self,
        phone: str,
        combined_message: str,
        source_message_ids: list[str],
    ) -> None:
        ...
```

### 9.4 Novo `conversation_history_service.py`

Responsabilidades:

- consultar API interna;
- retornar últimas N mensagens;
- formatar histórico para contexto da IA.

Interface sugerida:

```python
class ConversationHistoryService:
    async def get_recent_messages(self, phone: str, limit: int) -> list[dict]:
        ...
```

### 9.5 `intent_classifier.py`

Alterar para aceitar e preservar contexto conversacional.

Requisitos:

- incluir `recent_messages` no contexto;
- passar contexto completo para provider LLM;
- manter fallback por regras;
- fallback por regras pode ignorar histórico no MVP, mas não deve quebrar.

### 9.6 `openai_provider.py`

Alterar prompt para incluir histórico recente.

Formato sugerido:

```txt
Data atual: 2026-06-18
Categorias disponíveis: Mercado, Alimentação, Transporte
Contas disponíveis: Nubank, Itaú

Histórico recente:
[inbound] gastei 100 no mercado
[outbound] Em qual conta devo registrar?

Mensagem atual consolidada:
Nubank
```

Regras adicionais no prompt:

- use histórico para interpretar respostas curtas;
- não duplique lançamentos já confirmados;
- se a mensagem atual for correção, classifique como `correct_last`;
- se a mensagem atual cancelar, classifique como `cancel_last`;
- se for confirmação, preencha os dados faltantes com base no histórico.

## 10. Mudanças Esperadas na API

### 10.1 Endpoint de Histórico

Adicionar endpoint interno protegido por `InternalApiKeyGuard`.

Sugestão:

```ts
@Get('whatsapp/contacts/:phone/messages')
listMessagesByPhone(
  @Param('phone') phone: string,
  @Query('limit') limit = '15',
) {
  return this.internalService.listRecentMessagesByPhone(phone, Number(limit));
}
```

Service:

```ts
async listRecentMessagesByPhone(phone: string, limit = 15) {
  const normalizedPhone = normalizePhone(phone);
  const contact = await this.prisma.whatsappContact.findUnique({
    where: { phoneNumber: normalizedPhone },
  });

  if (!contact) return { conversationId: null, messages: [] };

  const conversation = await this.prisma.aiConversation.findFirst({
    where: { whatsappContactId: contact.id, status: 'active' },
    orderBy: { createdAt: 'desc' },
  });

  if (!conversation) return { conversationId: null, messages: [] };

  const messages = await this.prisma.aiMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 50),
  });

  return {
    conversationId: conversation.id,
    messages: messages.reverse(),
  };
}
```

### 10.2 Melhorias no Registro de Mensagem

Avaliar schema para suportar:

```prisma
model AiMessage {
  id                String   @id @default(uuid())
  conversationId    String   @map("conversation_id")
  direction         AiMessageDirection
  content           String
  metadata          Json?
  providerMessageId String?  @unique @map("provider_message_id")
  providerTimestamp DateTime? @map("provider_timestamp")
  processedAt       DateTime? @map("processed_at")
  createdAt         DateTime @default(now()) @map("created_at")

  @@index([conversationId, createdAt])
  @@map("ai_messages")
}
```

Esses campos podem ser adicionados depois do MVP se a equipe preferir manter `metadata` inicialmente.

## 11. Prompt e Comportamento da IA

### 11.1 Schema de Saída

A IA deve continuar retornando `FinancialIntent`:

```python
class FinancialIntent(BaseModel):
    intent: IntentType
    transaction_type: TransactionTypeEnum | None
    amount: float | None
    description: str | None
    category_name: str | None
    account_name: str | None
    transaction_date: str | None
    confidence: float
    needs_confirmation: bool
    confirmation_question: str | None
```

### 11.2 Casos Esperados

Mensagem completa:

```txt
gastei 47,50 no mercado ontem
```

Resultado esperado:

```json
{
  "intent": "create_transaction",
  "transaction_type": "expense",
  "amount": 47.5,
  "category_name": "Mercado",
  "transaction_date": "2026-06-17",
  "needs_confirmation": false
}
```

Mensagem quebrada:

```txt
gastei
47,50
no mercado
```

Resultado esperado após buffer:

```json
{
  "intent": "create_transaction",
  "transaction_type": "expense",
  "amount": 47.5,
  "category_name": "Mercado",
  "needs_confirmation": false
}
```

Resposta curta com histórico:

```txt
Histórico:
Usuário: paguei 300
IA: Em qual categoria devo registrar?

Mensagem atual:
internet
```

Resultado esperado:

```json
{
  "intent": "create_transaction",
  "transaction_type": "expense",
  "amount": 300,
  "category_name": "Moradia",
  "description": "internet",
  "needs_confirmation": false
}
```

Correção:

```txt
na verdade foi 120
```

Resultado esperado no MVP:

```json
{
  "intent": "correct_last",
  "confidence": 0.8,
  "needs_confirmation": true,
  "confirmation_question": "Você quer corrigir o último lançamento para R$ 120,00?"
}
```

Consulta:

```txt
quanto gastei esse mês?
```

Resultado esperado:

```json
{
  "intent": "query_summary",
  "confidence": 0.85
}
```

Se resumo ainda não estiver implementado, responder:

```txt
Consulta de resumo via WhatsApp ainda não está disponível. Veja no app.
```

## 12. Observabilidade

Logs mínimos:

- webhook recebido;
- mensagem persistida;
- mensagem adicionada ao buffer;
- debounce agendado;
- buffer processado;
- contato localizado ou não localizado;
- histórico carregado;
- provider LLM utilizado;
- fallback para regras;
- intenção extraída;
- confirmação solicitada;
- transação criada;
- resposta enviada;
- erro no processamento.

Métricas recomendadas:

- mensagens recebidas por minuto;
- mensagens processadas por minuto;
- tamanho médio do buffer;
- tempo médio entre recebimento e processamento;
- tempo de chamada LLM;
- taxa de fallback para regras;
- taxa de confirmação;
- taxa de erro por etapa;
- transações criadas via IA.

## 13. Segurança

Requisitos:

- validar assinatura do webhook em produção;
- proteger endpoints internos com `InternalApiKeyGuard`;
- não logar `OPENAI_API_KEY`;
- não expor tokens em respostas;
- revogar qualquer chave que tenha sido commitada ou exposta localmente;
- sanitizar metadata externa quando necessário;
- limitar tamanho de mensagem;
- limitar número de mensagens no contexto;
- limitar tamanho total do prompt.

Recomendações:

- `WHATSAPP_WEBHOOK_SECRET` obrigatório em produção;
- `INTERNAL_API_KEY` forte e diferente por ambiente;
- logs sem dados excessivamente sensíveis;
- política de retenção para mensagens, se houver necessidade legal/privacidade.

## 14. Critérios de Aceite

### 14.1 Buffer

- Dado que um usuário envia 3 mensagens em até 5 segundos, quando o debounce expira, então o sistema processa uma única mensagem consolidada.
- Dado que dois usuários enviam mensagens ao mesmo tempo, então cada telefone tem buffer separado.
- Dado que novas mensagens chegam antes do debounce, então o processamento é reagendado.
- Dado que o buffer atinge limite máximo de mensagens, então ele é processado sem aguardar mais.

### 14.2 Persistência

- Toda mensagem inbound recebida é salva em `AiMessage`.
- Toda resposta outbound é salva em `AiMessage`.
- Mensagens são associadas à conversa correta pelo telefone.
- Histórico das últimas 15 mensagens pode ser consultado pela API interna.

### 14.3 Processamento Assíncrono

- Webhook responde HTTP 200 rapidamente após enfileirar/bufferizar.
- Criação de lançamento acontece fora do request HTTP do webhook.
- Falha na IA não impede o webhook de responder ao provedor.
- Falha de processamento é registrada em logs.

### 14.4 Contexto da IA

- IA recebe mensagem atual consolidada.
- IA recebe últimas mensagens da conversa.
- IA recebe categorias e contas disponíveis.
- IA interpreta respostas curtas com base no histórico.
- IA não duplica lançamento já confirmado.

### 14.5 Transações

- Mensagem completa cria lançamento correto.
- Mensagem quebrada cria lançamento correto após agrupamento.
- Mensagem ambígua gera pergunta de confirmação.
- Resposta de confirmação completa o lançamento.
- Telefone não vinculado recebe mensagem orientando vínculo.

## 15. Testes Recomendados

### 15.1 Testes Unitários

AI Agent:

- `MessageBuffer` agrupa mensagens por telefone;
- `MessageBuffer` separa telefones diferentes;
- `MessageBuffer` respeita debounce;
- `MessageBuffer` respeita limite máximo;
- `MessageProcessor` chama serviços na ordem esperada;
- `ConversationHistoryService` trata resposta vazia;
- `IntentClassifier` aceita `recent_messages`.

API:

- endpoint de histórico retorna mensagens ordenadas;
- endpoint de histórico limita `limit`;
- endpoint de histórico normaliza telefone;
- registro de mensagem cria conversa quando não existe;
- registro de mensagem reutiliza conversa ativa.

### 15.2 Testes de Integração

Casos:

1. telefone vinculado envia mensagem completa;
2. telefone vinculado envia 3 mensagens quebradas;
3. dois telefones enviam mensagens intercaladas;
4. telefone não vinculado envia mensagem;
5. usuário responde confirmação curta;
6. provider reenvia mesmo `message_id`;
7. LLM falha e fallback por regras assume.

### 15.3 Testes Manuais via HTTP

Enviar mensagens sequenciais:

```bash
curl -X POST http://localhost:8010/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{"phone":"+5511999999999","message":"gastei","message_id":"m1"}'

curl -X POST http://localhost:8010/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{"phone":"+5511999999999","message":"47,50","message_id":"m2"}'

curl -X POST http://localhost:8010/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{"phone":"+5511999999999","message":"no mercado","message_id":"m3"}'
```

Resultado esperado:

- três mensagens inbound salvas;
- um único processamento;
- um único lançamento;
- uma resposta outbound salva.

## 16. Riscos e Decisões

### 16.1 Buffer em Memória

Risco:

- perde mensagens pendentes em restart;
- não funciona bem com múltiplas instâncias.

Decisão sugerida:

- aceitar no MVP;
- migrar para Redis antes de produção real.

### 16.2 Histórico Excessivo

Risco:

- prompts grandes;
- custo maior;
- risco de confundir a IA.

Decisão sugerida:

- limitar a 15 mensagens;
- enviar apenas `direction`, `content` e `createdAt`;
- truncar mensagens muito longas.

### 16.3 Duplicidade de Webhook

Risco:

- provedor reenviar mensagem;
- sistema criar lançamento duplicado.

Decisão sugerida:

- adicionar idempotência por `message_id`;
- antes disso, registrar `message_id` em metadata e monitorar.

### 16.4 Correções de Lançamento

Risco:

- usuário pedir "na verdade foi 120";
- sistema não saber se deve alterar transação anterior.

Decisão sugerida:

- MVP: classificar como `correct_last` e orientar uso do app ou pedir confirmação;
- evolução: implementar endpoint interno para consultar e corrigir último lançamento criado via IA.

## 17. Roadmap de Implementação

### Etapa 1: Histórico Persistido

- Criar endpoint interno para listar últimas mensagens por telefone.
- Garantir que `recordMessage` retorne `messageId` e `conversationId`.
- Ajustar metadata para incluir `message_id` do provedor.
- Adicionar testes da API.

### Etapa 2: Buffer Assíncrono MVP

- Criar `MessageBuffer` em memória no agent.
- Alterar webhook para salvar e enfileirar, não processar diretamente.
- Criar `MessageProcessor` extraindo lógica atual de `_process_message`.
- Adicionar locks por telefone.
- Adicionar testes unitários.

### Etapa 3: Contexto na IA

- Criar `ConversationHistoryService`.
- Incluir `recent_messages` em `_build_context`.
- Ajustar `OpenAiProvider` para incluir histórico no prompt.
- Adicionar testes com provider mockado.

### Etapa 4: Idempotência

- Adicionar suporte dedicado a `providerMessageId`.
- Evitar duplicidade de inbound.
- Evitar duplicidade de processamento.
- Adicionar testes de reenvio.

### Etapa 5: Produção

- Migrar buffer para Redis/fila.
- Adicionar retries e backoff.
- Adicionar métricas.
- Adicionar DLQ.
- Adicionar lock distribuído.

## 18. Definição de Pronto

A implementação pode ser considerada pronta para MVP quando:

- webhook responde rápido e não espera a IA;
- mensagens inbound/outbound são persistidas;
- mensagens quebradas são agrupadas por telefone;
- dois usuários simultâneos não misturam contexto;
- últimas 15 mensagens são usadas no contexto da IA;
- lançamento é criado corretamente após buffer;
- confirmação curta funciona com histórico;
- telefone não vinculado recebe resposta adequada;
- testes principais passam;
- logs permitem rastrear uma mensagem do webhook até a transação criada.

