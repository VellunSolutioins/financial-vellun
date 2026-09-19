# Mensageria durável para o fluxo WhatsApp → IA → lançamento

## Contexto

Hoje o `POST /webhook/whatsapp` faz trabalho demais dentro do ciclo HTTP: valida a assinatura, parseia o
payload, **chama a API principal** (`message_buffer.add` → `POST /internal/ai-events`,
`apps/ai-agent/src/services/message_buffer.py:186`) e dispara `asyncio.create_task` para áudio/imagem
(`apps/ai-agent/src/routers/webhook.py:130`).

Consequências: o ack para a Meta depende da API estar de pé; qualquer restart perde as mensagens em voo
(tasks locais e buffer em memória); o `ConversationManager` é um `dict` de processo
(`apps/ai-agent/src/services/conversation_manager.py:23`), então uma confirmação pendente não sobrevive a
deploy nem funciona com mais de uma instância; e um retry do `POST /internal/transactions/from-ai` cria
**lançamento duplicado**, porque `apps/api/src/internal/internal.service.ts:144` faz um
`prisma.transaction.create` sem chave de idempotência.

O objetivo é desacoplar recepção de processamento com um broker durável: o webhook só normaliza e publica
(202 após publisher confirm), e todo o resto roda em consumers escaláveis, com retry, DLQ, idempotência em
três níveis e ordenação garantida por telefone.

**Não existe broker no projeto** (`infra/docker/docker-compose.yml` só tem PostgreSQL; zero ocorrências de
`rabbitmq`/`amqp`/`celery`/`kafka`/`sqs`). Adotamos **RabbitMQ** como implementação inicial e **Redis** para
agrupamento distribuído, locks por telefone e estado de conversa — ambos novos no compose.

### Decisões confirmadas

1. **Áudio** é transcrito no InboundConsumer e entra no agrupamento por telefone; **imagem** roda visão no
   InboundConsumer e publica um job próprio com o intent pré-extraído + `forceConfirm` (preserva o
   comportamento atual de comprovante).
2. Consumers sobem no **lifespan do FastAPI** *e* existe entrypoint `python -m src.worker` para escalar
   separado (`RUN_CONSUMERS_IN_API=true|false`).
3. Rollout por flag `MESSAGE_PIPELINE=broker|legacy`, **padrão `broker`**; o caminho antigo permanece no repo
   por uma release.
4. Testes: dublês em memória por padrão; testes que exigem RabbitMQ/Redis reais ficam com
   `@pytest.mark.integration`, pulados por padrão.

---

## Arquitetura

```
Meta ──► POST /webhook/whatsapp ──► assinatura ──► normaliza ──► publish confirmado ──► 202
                                                                        │
                                                            whatsapp.inbound.v1
                                                                        │
                                                          InboundMessageConsumer
                                    ┌───────────────────────────────────┴──────────────┐
                            texto / áudio (transcrito)                          imagem (visão)
                                    │                                                  │
                        persiste AiMessage (idempotente)                    persiste AiMessage
                                    │                                                  │
                        agrupamento Redis por telefone                        job próprio direto
                                    │                                                  │
                                    └──────────► whatsapp.processing.v1 ◄──────────────┘
                                                            │
                                              MessageProcessingConsumer
                                    (lock por telefone → contato → assinatura →
                                     contexto → IA → confirmação → lançamento →
                                     resposta WhatsApp → outbound)
```

### Topologia RabbitMQ (tudo `durable`, `delivery_mode=PERSISTENT`, publisher confirms)

| Recurso | Tipo | Observação |
|---|---|---|
| `whatsapp.x` | exchange direct | routing keys `inbound`, `processing` |
| `whatsapp.retry.x` | exchange direct | destino das republicações com atraso |
| `whatsapp.dlx` | exchange direct | routing keys `inbound.dlq`, `processing.dlq` |
| `whatsapp.inbound.v1` | queue | `x-dead-letter-exchange=whatsapp.dlx`, rk `inbound.dlq` |
| `whatsapp.processing.v1` | queue | idem, rk `processing.dlq` |
| `whatsapp.{inbound,processing}.retry.{1s,4s,16s,60s,300s}` | queues | `x-message-ttl` fixo + `x-dead-letter-exchange=whatsapp.x` de volta à fila de origem |
| `whatsapp.inbound.dlq` / `whatsapp.processing.dlq` | queues | ligadas a `whatsapp.dlx` |

Buckets de retry com TTL fixo (sem head-of-line blocking de per-message TTL); o bucket é
`min(base * 2^attempt, max)` arredondado para o bucket mais próximo, com jitter aplicado como espera
aleatória curta (< 1s) antes da republicação. `x-attempt` viaja no header.

---

## Etapas de implementação

### 1. Contratos e abstrações — `apps/ai-agent/src/messaging/`

- `contracts.py` — Pydantic v2, `schemaVersion: Literal[1]`, `populate_by_name=True`, aliases camelCase:
  - `InboundMessageV1`: `eventId`, `schemaVersion`, `provider`, `providerMessageId`, `phone`, `kind`
    (`text|audio|image|unsupported`), `text`, `mediaId`, `mediaMime`, `caption`, `providerTimestamp`,
    `receivedAt`, `correlationId`.
  - `ProcessingJobV1`: `jobId`, `schemaVersion`, `phone`, `combinedMessage`, `sourceMessageIds`,
    `providerMessageIds`, `firstReceivedAt`, `lastReceivedAt`, `correlationId`, `attempt`,
    e os campos opcionais que preservam o comportamento de mídia: `responsePrefix` (eco de transcrição de
    áudio), `preExtractedIntent` (dump de `FinancialIntent`, caso comprovante), `forceConfirm`,
    `confirmQuestion`.
  - `DlqEnvelopeV1`: `payload`, `sourceQueue`, `attempts`, `errorType`, `errorMessage` (sanitizada),
    `firstFailedAt`, `failedAt`, `correlationId`.
- `base.py` — `MessagePublisher` (ABC: `publish(routing_key, model, *, correlation_id)`, `publish_many`,
  `healthy()`), `MessageConsumer` (ABC: `start(handler)`, `stop(drain_timeout)`), exceções
  `PublishError`, `TransientError`, `PermanentError`.
- `rabbitmq/connection.py` — `aio_pika.connect_robust` com backoff exponencial; canal de publicação com
  `publisher_confirms=True`, reutilizado; canal de consumo separado com `prefetch_count`.
- `rabbitmq/topology.py` — `declare_topology(channel)` idempotente (todas as filas/exchanges acima).
- `rabbitmq/publisher.py`, `rabbitmq/consumer.py` — ack manual, `Semaphore` de concorrência,
  classificação de erro → retry bucket ou DLQ.
- `inmemory.py` — `InMemoryPublisher`/`InMemoryConsumer` para testes e `MESSAGE_BROKER=inmemory`.
- `factory.py` — seleciona por `MESSAGE_BROKER`.

Nova dependência: `aio-pika>=9.4` em `pyproject.toml` + `requirements.txt`; `redis>=5.0` promovido de extra
opcional para dependência obrigatória.

### 2. Producer e webhook

Reescrever `apps/ai-agent/src/routers/webhook.py` → `receive_whatsapp`:

1. `raw_body = await request.body()` → `_verify_signature` (mantido como está, inclusive o fallback
   `X-Webhook-Signature` de dev) → 401 se inválido, **sem publicar**.
2. `parse_inbound(raw_body)` (mantido — `apps/ai-agent/src/services/whatsapp_inbound.py` já ignora `statuses`
   e devolve `[]`) → se vazio, `200 {"status":"ignored"}`.
3. Mapear cada `InboundMessage` → `InboundMessageV1` (`eventId`/`correlationId` gerados aqui; telefone
   normalizado por um novo `phone.normalize_phone`, espelhando `apps/api/src/common/phone.util.ts`).
4. `await publisher.publish_many(...)` — todas confirmadas → `202 Accepted`; qualquer `PublishError` →
   `503`. Mensagem acima de `MESSAGE_MAX_CHARS` é truncada/descartada **antes** de publicar.
5. Remover imports de `media_processor`, `message_buffer` e a função `_schedule` do módulo (no modo `broker`).

O handshake `GET /webhook/whatsapp` fica intocado.

### 3. InboundMessageConsumer — `apps/ai-agent/src/consumers/inbound_consumer.py`

1. Valida `InboundMessageV1` → `ValidationError` = falha permanente → DLQ.
2. `kind == "unsupported"` → responde a mensagem de fallback e acka (sem job financeiro).
3. Persiste `AiMessage` via `audit_service.log_message_detailed` (já devolve `duplicate: true` graças ao
   `providerMessageId @unique`); duplicata = sucesso, acka sem reprocessar.
4. **Mídia** (refatorar `apps/ai-agent/src/services/media_processor.py` extraindo a parte de
   download/STT/visão para `media_resolver.py`, mantendo contato + `subscription_gate` **antes** de qualquer
   chamada paga):
   - áudio → transcrição; texto entra no agrupamento com `responsePrefix = 'Entendi: "…".\n'`;
   - imagem → `intent_classifier.classify_image`; publica `ProcessingJobV1` próprio com
     `preExtractedIntent`, `forceConfirm=True`, `confirmQuestion`, `sourceMessageIds=[id]`.
5. Ack **só depois** de persistido e gravado de forma durável no agrupamento (ou publicado, no caso de imagem).
6. Falha transitória (API/OpenAI/WhatsApp/rede) → retry bucket; permanente ou tentativas esgotadas → DLQ.

### 4. Agrupamento distribuído — `apps/ai-agent/src/grouping/redis_group_store.py`

Chaves: `group:{phone}` (LIST), `group:first:{phone}` (epoch da 1ª mensagem), `group:due` (ZSET),
`group:lock:{phone}` (SET NX PX).

- `append()`: `RPUSH` + `SETNX group:first` + `ZADD group:due min(now+debounce, first+max_age)`.
  **Corrige o bug atual** de `apps/ai-agent/src/services/redis_buffer.py:78-84`, onde `max_due` era
  recalculado a partir de `now` e os dois branches eram idênticos — a idade máxima nunca era aplicada.
- `GroupFlusherWorker` (loop `WORKER_POLL_INTERVAL_SECONDS`): `ZRANGEBYSCORE` → por telefone adquire
  `group:lock` → `LRANGE` (**sem apagar**) → monta `ProcessingJobV1` com
  `jobId = uuid5(NAMESPACE_URL, "|".join(sorted(sourceMessageIds)))` → publica com confirm → **só então**
  `DEL group:{phone}` + `DEL group:first` + `ZREM` → libera lock.
  Crash entre confirm e DEL republica o mesmo grupo → mesmo `jobId` determinístico → deduplicado adiante.
- Parâmetros preservados: debounce 5s, máx. 10 mensagens, idade máxima 30s, ordem de recebimento.
- `InMemoryGroupStore` equivalente para testes e modo sem Redis.

### 5. MessageProcessingConsumer — `apps/ai-agent/src/consumers/processing_consumer.py`

1. Valida `ProcessingJobV1`; `EXISTS job:done:{jobId}` → acka imediatamente (idempotência nível 2).
2. Adquire `proc:lock:{phone}` (Redis, TTL renovado). Se não conseguir, republica no bucket de 1s
   (não faz spin) — garante ordenação lógica por telefone com múltiplos consumers.
3. Chama `message_processor.process_job(job)` — refatoração de `process_buffered_message`
   (`apps/ai-agent/src/services/message_processor.py:46`) que recebe o job e passa `idempotency_key=jobId`
   adiante; quando o job traz `preExtractedIntent`, pula a classificação e vai direto para
   `handle_intent(..., force_confirm=True, confirm_question=...)`, exatamente como o fluxo de imagem faz hoje.
   Ordem preservada: contato → assinatura → contexto → confirmação pendente → IA → extração → lançamento →
   resposta → outbound.
4. `SET job:done:{jobId}` (TTL 24h) → ack. Concorrência limitada por `PROCESSING_CONSUMER_CONCURRENCY`.

### 6. Estado da conversa distribuído

`conversation_manager.py`: manter a API, trocar a implementação por `RedisConversationStore`
(chave `conv:{phone}`, JSON versionado `{"v":1,"pendingIntent":…,"awaitingConfirmation":…,"lastMessageAt":…}`,
TTL `CONVERSATION_STATE_TTL_SECONDS`, update atômico via Lua CAS). Métodos passam a ser `async` — atualizar
os call sites em `message_processor.py` (linhas 77, 85, 135, 159). `InMemoryConversationStore` mantido para
testes e modo `legacy`.

### 7. Idempotência da criação do lançamento (API NestJS)

- **Prisma** (`apps/api/prisma/schema.prisma`, model `Transaction`):
  `idempotencyKey String? @unique @map("idempotency_key")`.
- **Migration** `apps/api/prisma/migrations/20260905HHMMSS_add_transaction_idempotency_key/migration.sql` —
  `ADD COLUMN` nullable + `CREATE UNIQUE INDEX`, compatível com dados existentes. Seguir o formato de
  `20260618140000_add_ai_message_provider_fields/migration.sql`.
- **DTO** `apps/api/src/internal/dto/create-ai-transaction.dto.ts`:
  `@IsOptional() @IsString() @MaxLength(255) idempotencyKey?: string`. Obrigatório por causa do
  `forbidNonWhitelisted: true` do `ValidationPipe` global.
- **Service** `apps/api/src/internal/internal.service.ts:129`: se `idempotencyKey` vier, `findUnique` antes;
  `create` dentro de `prisma.$transaction` junto com o update de `aiExtractedTransaction`; `catch` de
  `Prisma.PrismaClientKnownRequestError` código `P2002` → relê e devolve a transação existente — mesmo padrão
  já usado em `recordMessage` (`internal.service.ts:243-258`) e em `webhook-event.service.ts`.
- **Agent** `apps/ai-agent/src/services/transaction_creator.py`: enviar `idempotencyKey` e trocar
  `source: "ai"` por **`source: "whatsapp"`** (requisito 5). O enum `TransactionSource` do Prisma e o
  `@IsEnum(['ai','whatsapp'])` do DTO já aceitam.

### 8. Retry, DLQ, observabilidade, health e ciclo de vida

- `src/observability/logging.py` — `contextvars` com `correlationId`, `providerMessageId`, `jobId`,
  `phoneHash`; `JsonFormatter`; `mask_phone()`/`hash_phone()` (telefone completo **nunca** em produção;
  nada de token/segredo/valor financeiro em log).
- Estender `apps/ai-agent/src/services/metrics.py` com: `webhook_received`, `publish_confirmed`,
  `publish_failed`, `webhook_latency_ms`, `messages_consumed`, `messages_duplicated`, `queue_backlog`,
  `receive_to_process_ms`, `processing_duration_ms`, `retries`, `dlq_messages`, `transactions_created`,
  `transactions_idempotent_hit`, `whatsapp_send_failed`.
- `apps/ai-agent/src/main.py`: `/health/live` (processo) e `/health/ready` (broker publicável + consumindo +
  Redis `PING`) — readiness falha se não puder publicar/consumir. `/health` mantido como alias de liveness
  por compatibilidade.
- Lifespan: conecta broker → declara topologia → sobe publisher, consumers e `GroupFlusherWorker`.
  Shutdown gracioso: cancela consumer tags (para de receber), aguarda in-flight com timeout,
  `nack(requeue=True)` no que sobrar, fecha httpx/Redis/broker.
- `src/worker.py`: mesmo bootstrap sem servidor HTTP, para `RUN_CONSUMERS_IN_API=false`.

### 9. Configuração e infraestrutura

- `apps/ai-agent/src/config.py`: `message_pipeline` (`broker|legacy`), `message_broker`, `rabbitmq_url`,
  `rabbitmq_inbound_queue`, `rabbitmq_processing_queue`, `rabbitmq_prefetch`,
  `inbound_consumer_concurrency`, `processing_consumer_concurrency`, `message_max_retries`,
  `message_retry_base_seconds`, `message_retry_max_seconds`, `conversation_state_ttl_seconds`,
  `run_consumers_in_api`, `group_store_backend`.
- `infra/docker/docker-compose.yml`: serviços `rabbitmq` (`rabbitmq:3.13-management`, 5672/15672, volume,
  healthcheck `rabbitmq-diagnostics -q ping`) e `redis` (`redis:7-alpine`, 6379, `--appendonly yes`, volume,
  healthcheck `redis-cli ping`).
- `apps/ai-agent/.env.example` e `infra/docker/.env.example`: novas variáveis documentadas.
- `apps/api/.env.example`: nada novo (a idempotência é só coluna + DTO).
- `README.md`: substituir a seção "Webhook → Buffer → Worker" pela nova arquitetura, filas, como rodar, como
  publicar mensagem de teste, DLQ e o painel do RabbitMQ.
- Raiz `package.json`: `db:up` já sobe o compose inteiro (mesmo arquivo); adicionar `agent:worker`.
- `docs/whatsapp-ai-async-processing-requirements.md`: seção nova descrevendo a arquitetura de mensageria e o
  runbook operacional (drenar DLQ, reprocessar).
- `CLAUDE.md`: atualizar tabela de comandos/serviços.

### 10. Testes

Adicionar `[tool.pytest.ini_options]` em `apps/ai-agent/pyproject.toml` (`asyncio_mode = "auto"`, `testpaths`,
marker `integration`) e um `tests/conftest.py` com fixtures de `InMemoryPublisher`, `InMemoryGroupStore`,
`InMemoryConversationStore` e fakes de API/OpenAI/WhatsApp.

Novos arquivos em `apps/ai-agent/tests/`: `test_webhook_publish.py`, `test_inbound_consumer.py`,
`test_group_store.py`, `test_processing_consumer.py`, `test_conversation_store.py`, `test_retry_dlq.py`,
`test_messaging_contracts.py`, e `test_broker_integration.py` (marcado `integration`).

Mapeamento dos 20 casos obrigatórios:

| # | Caso | Onde |
|---|---|---|
| 1,2,3,4,5,6 | 202 após confirm, 503 em falha, 401 sem publicar, multi-mensagem, evento de status | `test_webhook_publish.py` |
| 7,9,10,11,18 | dedupe de `providerMessageId`, ack só após persistir, retry transitório, DLQ, mídia fora do HTTP | `test_inbound_consumer.py` |
| 12 | fragmentos agrupados em ordem | `test_group_store.py` |
| 8,13,14,16,17,19,20 | sem transação duplicada, paralelismo entre telefones, ordem no mesmo telefone, timeout pós-criação, shutdown devolve jobs, conta/categoria de outro usuário, sem assinatura não chama LLM | `test_processing_consumer.py` |
| 15 | confirmação pendente sobrevive ao restart | `test_conversation_store.py` |

Lado NestJS — `apps/api/src/internal/internal.service.spec.ts`: casos de `idempotencyKey` (hit devolve a
existente sem criar; `P2002` concorrente devolve a existente; `source` gravado como `whatsapp`).

---

## Arquivos principais

**Novos** — `apps/ai-agent/src/messaging/` (contracts, base, factory, inmemory, `rabbitmq/*`),
`apps/ai-agent/src/consumers/` (inbound, processing), `apps/ai-agent/src/grouping/`,
`apps/ai-agent/src/observability/logging.py`, `apps/ai-agent/src/services/media_resolver.py`,
`apps/ai-agent/src/services/phone.py`, `apps/ai-agent/src/worker.py`, migration Prisma, novos testes.

**Modificados** — `apps/ai-agent/src/routers/webhook.py`, `apps/ai-agent/src/main.py`,
`apps/ai-agent/src/config.py`, `apps/ai-agent/src/services/message_processor.py`,
`apps/ai-agent/src/services/conversation_manager.py`, `apps/ai-agent/src/services/transaction_creator.py`,
`apps/ai-agent/src/services/media_processor.py`, `apps/ai-agent/src/services/metrics.py`,
`apps/ai-agent/pyproject.toml`, `apps/ai-agent/requirements.txt`, `apps/api/prisma/schema.prisma`,
`apps/api/src/internal/dto/create-ai-transaction.dto.ts`, `apps/api/src/internal/internal.service.ts`,
`infra/docker/docker-compose.yml`, `.env.example`s, `README.md`, `CLAUDE.md`.

**Preservados sem alteração** (modo `legacy`, removíveis na próxima release) —
`apps/ai-agent/src/services/message_buffer.py`, `apps/ai-agent/src/services/redis_buffer.py` e seus testes.

**Reaproveitados como estão** — `whatsapp_inbound.py` (`parse_inbound` já trata Meta, payload simplificado e
eventos de status), `audit_service.py` (`log_message_detailed` já devolve `duplicate`),
`subscription_gate.py`, `contact_service.py`, `intent_classifier.py`, `confirmation_rules.py`,
`transcription.py`, `whatsapp_media.py`, `services/messenger/*`.

---

## Verificação

```bash
# 1. Infra local (Postgres + RabbitMQ + Redis)
pnpm db:up
# painel do RabbitMQ: http://localhost:15672 (guest/guest)

# 2. Migration da idempotência
pnpm --filter @financial-vellun/api exec prisma migrate deploy
pnpm --filter @financial-vellun/api exec prisma generate

# 3. Testes
pnpm --filter @financial-vellun/api test                       # inclui internal.service.spec.ts
cd apps/ai-agent && .venv\Scripts\python.exe -m pytest -q       # unitários (dublês em memória)
cd apps/ai-agent && .venv\Scripts\python.exe -m pytest -m integration -q   # com broker/Redis reais

# 4. Subir tudo
pnpm dev

# 5. Publicar uma mensagem de teste (payload simplificado de dev)
curl -X POST http://localhost:8010/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{"phone":"+5541999999999","message":"gastei 47,50 no mercado","message_id":"wamid.test-1"}'
# esperado: HTTP 202 {"status":"accepted"}

# 6. Health
curl http://localhost:8010/health/live
curl http://localhost:8010/health/ready     # 503 se RabbitMQ/Redis estiverem fora
curl http://localhost:8010/metrics
```

Checagens manuais:

- **Durabilidade**: publicar, parar o agent antes do debounce, subir de novo — a mensagem é reprocessada e o
  lançamento aparece uma única vez.
- **Idempotência**: reenviar o mesmo `message_id` — nenhuma `AiMessage` nem `Transaction` duplicada.
- **DLQ**: derrubar a API principal e enviar uma mensagem — observar retries nos buckets e a chegada em
  `whatsapp.processing.dlq` no painel do RabbitMQ.
- **503**: parar o RabbitMQ e chamar o webhook.
- **Ordenação**: enviar "gastei 100 no mercado" seguido de "sim" com dois workers rodando — a confirmação não
  pode ser processada antes da pergunta.

---

## Riscos e pendências

- O comportamento atual de `_merge_confirmation_reply` (`message_processor.py:199-205`) trata
  `confirmed=None` como "seguir em frente" e força a confiança ao threshold. Isso é preservado tal e qual;
  **não** faz parte deste escopo, mas fica registrado porque agora esse caminho passa a rodar concorrente.
- `AiExtractedTransaction` continua sem unique em `sourceMessageId` — um retry pode gerar linhas de extração
  duplicadas (sem duplicar lançamento, que é o que a `idempotencyKey` garante). Fora de escopo; sinalizado.
- Não há CI (`.github/` não existe) nem manifesto de deploy no repo, então a configuração de produção fica
  documentada no README, sem pipeline para atualizar.
- Dois containers novos aumentam o custo de ambiente local; o modo `MESSAGE_BROKER=inmemory` +
  `GROUP_STORE_BACKEND=memory` permite rodar sem eles em desenvolvimento.
- A remoção definitiva de `message_buffer.py`/`redis_buffer.py` fica para uma release seguinte, após o
  pipeline `broker` acumular tráfego real.
