# Plano: Processamento Assíncrono de Mensagens WhatsApp com Contexto de IA

## Context

Hoje o webhook `POST /webhook/whatsapp` ([webhook.py](../apps/ai-agent/src/routers/webhook.py)) processa cada mensagem de forma **síncrona e isolada**: valida assinatura, resolve o contato, classifica a intenção (LLM ou regras), cria o lançamento e só então responde ao provedor — tudo dentro do request HTTP. Isso quebra o uso real do WhatsApp, onde o usuário fragmenta uma instrução em várias mensagens curtas ("gastei" / "47,50" / "no mercado"), e ignora o histórico recente da conversa (ex.: responder "Nubank" a uma pergunta anterior).

O objetivo é introduzir uma camada de **ingestão → buffer/debounce por telefone → processamento assíncrono → contexto conversacional → idempotência**, evoluindo de um MVP em memória até uma arquitetura de produção com Redis/fila. A "Definição de Pronto" está em [requisitos §18](../docs/whatsapp-ai-async-processing-requirements.md).

**Decisões do usuário:**
- Escopo-alvo: **Etapas 1–5** (MVP completo + hardening de produção).
- Messenger: **stub de log em dev**, **integração real de provedor em produção**, selecionável por env (mesmo padrão de `llm/factory.py`).

### Estado atual confirmado pela exploração
- API já tem modelos `WhatsappContact`, `AiConversation`, `AiMessage`, `AiExtractedTransaction` ([schema.prisma:212-276](../apps/api/prisma/schema.prisma)) e enums `AiConversationStatus`/`AiMessageDirection`/`AiExtractionStatus`.
- `recordMessage` já faz upsert do contato, reusa conversa `active` e **já retorna `{ id, conversationId }`** ([internal.service.ts:109-151](../apps/api/src/internal/internal.service.ts)).
- Existe `normalizePhone` em [phone.util.ts](../apps/api/src/common/phone.util.ts) e `InternalApiKeyGuard` em [internal-api-key.guard.ts](../apps/api/src/internal/guards/internal-api-key.guard.ts).
- **Não existe** endpoint de histórico por telefone, nem campo `providerMessageId`, nem índices em `AiMessage`.
- Agent tem `IntentClassifier` ([intent_classifier.py](../apps/ai-agent/src/services/intent_classifier.py)), `OpenAiProvider` ([openai_provider.py](../apps/ai-agent/src/services/llm/openai_provider.py)), `ConversationManager` em memória, `Messenger` que só loga, e `api_client` com header `x-internal-api-key`.

---

## Etapa 1 — Histórico Persistido (API)

**Objetivo:** expor o histórico recente da conversa para a IA usar como contexto.

1. **Novo endpoint interno** `GET /internal/whatsapp/contacts/:phone/messages?limit=15`
   - Controller: adicionar método em [internal.controller.ts](../apps/api/src/internal/controllers/internal.controller.ts) (já protegido por `InternalApiKeyGuard`).
   - Service: `listRecentMessagesByPhone(phone, limit)` em [internal.service.ts](../apps/api/src/internal/internal.service.ts):
     - normalizar via `normalizePhone`;
     - localizar `WhatsappContact`; se ausente → `{ conversationId: null, messages: [] }`;
     - localizar `AiConversation` `status: 'active'` mais recente; se ausente → vazio;
     - `aiMessage.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(limit, 50) })` e retornar `.reverse()` (cronológico) com `{ id, direction, content, metadata, createdAt }`.
   - DTO de query simples para `limit` (default 15, máx 50).
2. Confirmar que `recordMessage` continua retornando `conversationId`/`messageId` (já retorna).
3. Garantir que a metadata de inbound já carrega `messageId`/`timestamp` do provedor (o agent já envia em `audit_service`).

**Critério:** endpoint retorna últimas N mensagens ordenadas, normaliza telefone, limita `limit`, retorna vazio sem conversa.

---

## Etapa 2 — Buffer Assíncrono MVP (Agent)

**Objetivo:** webhook responde rápido; processamento de IA sai do request; mensagens fragmentadas são agrupadas por telefone.

1. **`config.py`** — novos campos em `Settings` ([config.py](../apps/ai-agent/src/config.py)):
   - `message_buffer_debounce_seconds: int = 5`
   - `message_buffer_max_messages: int = 10`
   - `message_buffer_max_age_seconds: int = 30`
   - `conversation_context_message_limit: int = 15`
   - `message_buffer_backend: str = "memory"` (preparando Etapa 5: `"memory" | "redis"`)
2. **Novo `services/message_processor.py`** — extrair a lógica atual de `_process_message` ([webhook.py:67-137](../apps/ai-agent/src/routers/webhook.py)) para `MessageProcessor.process_buffered_message(phone, combined_message, source_message_ids)`. Mantém: resolver contato, confirmação pendente, classificar, criar/perguntar, enviar via `messenger`, registrar outbound/extração.
3. **Novo `services/message_buffer.py`** — `MessageBuffer` em memória:
   - `add(phone, message, source_message_id)`: persiste inbound (via `audit_service.log_message`), adiciona ao `PhoneBuffer`, (re)agenda task `asyncio` com debounce; flush imediato ao atingir `max_messages` ou `max_age`.
   - `asyncio.Lock` **por telefone** para serializar o flush (§6.2); limpeza atômica do buffer ao processar.
   - dataclasses `BufferedMessage` / `PhoneBuffer` conforme §9.2.
   - definir interface `BufferBackend` abstrata (memory agora, redis na Etapa 5).
4. **Refatorar `webhook.py`** — passar a fazer apenas: validar assinatura → validar payload → `message_buffer.add(...)` → `return {"status": "accepted"}`. Não chamar IA nem criar lançamento no request. Manter retorno de debug opcional apenas fora de produção.
5. **Persistência inbound antes do buffer** — garantir que a inbound é salva antes de enfileirar (§3.1).

**Critério:** 3 mensagens em ≤5s geram 1 processamento consolidado; telefones distintos têm buffers isolados; nova mensagem reagenda; limite máximo força flush; webhook responde 200 sem esperar a IA.

---

## Etapa 3 — Contexto Conversacional na IA (Agent)

**Objetivo:** a IA recebe e usa o histórico recente.

1. **Novo `services/conversation_history_service.py`** — `get_recent_messages(phone, limit)` consome o endpoint da Etapa 1 via `api_client`; trata resposta vazia; trunca conteúdo muito longo; retorna `[{direction, content, created_at}]`.
2. **`_build_context`** (mover para `MessageProcessor`) — incluir `recent_messages` e `current_message` (mensagem consolidada), além de `today`, `profile_type`, `categories`, `accounts` (§3.7).
3. **`intent_classifier.py`** — `classify` aceita e repassa `recent_messages` ao provider; fallback de regras ignora histórico mas **não quebra** ([intent_classifier.py:107-117](../apps/ai-agent/src/services/intent_classifier.py)).
4. **`openai_provider.py`** — montar prompt com bloco "Histórico recente" + "Mensagem atual consolidada" ([openai_provider.py:47-71](../apps/ai-agent/src/services/llm/openai_provider.py)). Regras adicionais: usar histórico só como contexto, não duplicar lançamento já confirmado, classificar correção como `correct_last` e cancelamento como `cancel_last`, preencher campos faltantes a partir do histórico em confirmações.
5. **Limites de segurança** (§13): máximo de mensagens no contexto e tamanho total do prompt.

**Critério:** IA recebe mensagem consolidada + últimas 15 mensagens + categorias/contas; interpreta respostas curtas via histórico; não duplica lançamento confirmado.

---

## Etapa 4 — Idempotência (API + Agent)

**Objetivo:** reenvio de webhook pelo provedor não duplica mensagem/lançamento.

1. **Schema Prisma** ([schema.prisma](../apps/api/prisma/schema.prisma), modelo `AiMessage`):
   - `providerMessageId String? @unique @map("provider_message_id")`
   - `providerTimestamp DateTime? @map("provider_timestamp")`
   - `processedAt DateTime? @map("processed_at")` (opcional)
   - `@@index([conversationId, createdAt])`
   - gerar migration (`prisma migrate dev --name add_ai_message_provider_fields`).
2. **`recordMessage`** — gravar `providerMessageId`/`providerTimestamp`; se `providerMessageId` já existe, retornar a mensagem existente sem duplicar (capturar violação de unique ou checar antes).
3. **Agent** — antes de criar lançamento, garantir que a extração ainda não gerou transação (status `confirmed` + `transactionId`); deduplicar inbound por `message_id` no buffer.

**Critério:** mesmo `message_id` reenviado não cria 2ª mensagem nem 2º lançamento.

---

## Etapa 5 — Produção (Redis/Fila + Métricas + Messenger real)

**Objetivo:** durabilidade, múltiplas instâncias, observabilidade e envio real.

1. **Buffer/lock distribuído (Redis)** — implementar `RedisBufferBackend` por trás da interface `BufferBackend` da Etapa 2: `buffer:{phone}`, agendamento `debounce:{phone}`, `lock:{phone}` distribuído. Worker separado que pega lock, lê e limpa buffer atomicamente, processa, libera lock (§8.2). Selecionável por `message_buffer_backend=redis`.
2. **Fila com retry/backoff + DLQ** — jobs por telefone com idempotência por `message_id`; falha de processamento não derruba o worker (registra erro e decide reprocessar/DLQ).
3. **Messenger real** — abstrair `Messenger` num factory (espelhar [llm/factory.py](../apps/ai-agent/src/services/llm/factory.py)):
   - `LogMessenger` (atual, dev) e `WhatsappProviderMessenger` (produção) usando `WHATSAPP_PROVIDER_TOKEN`;
   - seleção por env `WHATSAPP_PROVIDER` (ex.: `log` | `cloud-api`);
   - toda resposta enviada continua salva como `AiMessage` outbound.
4. **Observabilidade** (§12) — logs estruturados de cada etapa (webhook recebido → buffer → debounce → processado → contato → histórico → LLM/fallback → intenção → confirmação → transação → resposta → erro) e métricas (mensagens/min, tempo recebimento→processamento, latência LLM, taxa de fallback/confirmação/erro, transações criadas).
5. **Segurança** (§13) — `WHATSAPP_WEBHOOK_SECRET` obrigatório em produção; nunca logar `OPENAI_API_KEY`/tokens; limitar tamanho de mensagem e do contexto.

**Critério:** buffer sobrevive a restart, suporta múltiplas instâncias, mensagens com retry/DLQ, métricas disponíveis, envio real funcionando em produção.

---

## Arquivos principais

**API (`apps/api`)**
- [internal.controller.ts](../apps/api/src/internal/controllers/internal.controller.ts) — novo endpoint de histórico
- [internal.service.ts](../apps/api/src/internal/internal.service.ts) — `listRecentMessagesByPhone`, idempotência em `recordMessage`
- [schema.prisma](../apps/api/prisma/schema.prisma) — campos/índices em `AiMessage` + migration
- reusar [phone.util.ts](../apps/api/src/common/phone.util.ts), `InternalApiKeyGuard`

**Agent (`apps/ai-agent`)**
- [webhook.py](../apps/ai-agent/src/routers/webhook.py) — só validar + bufferizar + responder
- `services/message_buffer.py` (novo) — buffer/debounce/lock + interface `BufferBackend`
- `services/message_processor.py` (novo) — lógica extraída de `_process_message`
- `services/conversation_history_service.py` (novo) — consumir endpoint de histórico
- [intent_classifier.py](../apps/ai-agent/src/services/intent_classifier.py) / [openai_provider.py](../apps/ai-agent/src/services/llm/openai_provider.py) — `recent_messages` no contexto/prompt
- [messenger.py](../apps/ai-agent/src/services/messenger.py) — factory log/produção (Etapa 5)
- [config.py](../apps/ai-agent/src/config.py) — novos campos de Settings

---

## Verificação

**Unitários (agent):** `MessageBuffer` agrupa por telefone, separa telefones distintos, respeita debounce e limite máximo; `MessageProcessor` chama serviços na ordem esperada; `ConversationHistoryService` trata resposta vazia; `IntentClassifier` aceita `recent_messages`.

**Unitários (API):** histórico retorna ordenado/limitado/normalizado; `recordMessage` cria conversa quando não existe e reusa a ativa; idempotência por `providerMessageId`.

**Integração / manual (HTTP)** — sequência do §15.3:
```bash
curl -X POST http://localhost:8010/webhook/whatsapp -H "Content-Type: application/json" \
  -d '{"phone":"+5511999999999","message":"gastei","message_id":"m1"}'
curl -X POST http://localhost:8010/webhook/whatsapp -H "Content-Type: application/json" \
  -d '{"phone":"+5511999999999","message":"47,50","message_id":"m2"}'
curl -X POST http://localhost:8010/webhook/whatsapp -H "Content-Type: application/json" \
  -d '{"phone":"+5511999999999","message":"no mercado","message_id":"m3"}'
```
Esperado: 3 inbound salvas, **1** processamento, **1** lançamento, 1 outbound salva. Validar também: dois telefones intercalados não misturam contexto; telefone não vinculado recebe mensagem de orientação; resposta curta com histórico ("internet" após "paguei 300") completa o lançamento; reenvio de `m1` não duplica.

Rodar o stack com `pnpm dev` (DB + API + agent). Aplicar migration com `pnpm --filter @financial-vellun/api exec prisma migrate dev`.
