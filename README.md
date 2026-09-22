# Financial Vellun

Aplicação de controle financeiro para pessoa física e jurídica, com lançamentos via WhatsApp usando agente de IA.

## Estrutura do monorepo

```
financial-vellun/
  apps/
    web/            # Frontend — Next.js 14 + Tailwind CSS + shadcn/ui
    api/            # API principal — NestJS + Prisma + PostgreSQL
    ai-agent/       # Agente de IA — Python + FastAPI (venv própria)
  packages/
    shared/         # Tipos, enums e schemas Zod compartilhados
    config/         # Configurações de TS, ESLint e Prettier
  infra/
    docker/         # Docker Compose: PostgreSQL + RabbitMQ + Redis
    observability/  # Alloy, alertas, dashboards (ver infra/observability/README.md)
  docs/             # requisitos, runbook, observabilidade e ADRs (docs/adrs/)
  plan/             # planos de implementação
  Dockerfile.ai-agent  # imagem do agente (produção)
  Dockerfile.alloy     # imagem do Alloy no Railway
```

## Pré-requisitos

| Ferramenta     | Versão                                   | Verificar                |
| -------------- | ---------------------------------------- | ------------------------ |
| Node.js        | ≥ 20 (`.nvmrc` fixa `22.13.1`)           | `node -v`                |
| pnpm           | ≥ 9 (`corepack enable` usa a do projeto) | `pnpm -v`                |
| Python         | ≥ 3.11 (`.python-version` do agente: `3.12`) | `python --version`   |
| Docker Desktop | com Compose v2                           | `docker compose version` |

---

## Configuração inicial (primeira vez)

Resumo da ordem — cada passo está detalhado abaixo:

```bash
pnpm install                                   # 1. dependências Node
# 2. copiar os quatro .env.example (infra/docker, api, web, ai-agent)
pnpm db:up                                     # 3. PostgreSQL + RabbitMQ + Redis
pnpm prisma:generate                           # 4. client do Prisma
pnpm --filter @financial-vellun/api exec prisma migrate deploy
pnpm prisma:seed
# 5. venv do agente de IA + dependências
pnpm dev                                       # 6. API + Web + agente
```

### 1. Instalar dependências Node

```bash
pnpm install
```

### 2. Configurar variáveis de ambiente

São **quatro** arquivos. Copie os exemplos (os valores padrão já funcionam para
desenvolvimento local, exceto onde indicado):

```bash
cp infra/docker/.env.example     infra/docker/.env
cp apps/api/.env.example         apps/api/.env
cp apps/web/.env.local.example   apps/web/.env.local
cp apps/ai-agent/.env.example    apps/ai-agent/.env
```

> No PowerShell, troque `cp` por `Copy-Item`.

**Infraestrutura** (`infra/docker/.env`) — **obrigatório**: o `docker-compose.yml`
lê este arquivo (`env_file`) e o `pnpm db:up` falha sem ele.

| Variável                                           | Descrição                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Credenciais do Postgres. Precisam bater com o `DATABASE_URL` da API |
| `RABBITMQ_USER` / `RABBITMQ_PASSWORD`              | Usuário do broker. Obrigatórios (sem padrão). Precisam bater com `RABBITMQ_URL` do agente |
| `REDIS_PASSWORD`                                   | Senha do Redis (`requirepass`). Obrigatória. Precisa bater com `REDIS_URL` do agente |
| `GRAFANA_CLOUD_*`                                  | Só para `pnpm obs:up` (Alloy local). Podem ficar vazios               |

> As credenciais do Postgres só valem na **primeira** subida do volume. Se trocar
> depois, rode `pnpm db:down` e remova o volume `financial-vellun-postgres`.

**API** (`apps/api/.env`):

| Variável                     | Descrição                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`               | Conexão com o PostgreSQL. **Porta `5433`** no host (o compose mapeia `5433:5432`) |
| `JWT_SECRET`                 | Segredo dos access tokens (≥ 32 chars)                                         |
| `JWT_REFRESH_SECRET`         | Segredo dos refresh tokens (≥ 32 chars)                                        |
| `API_PORT`                   | Porta da API (padrão `3001`; `PORT` tem precedência, usado no Railway)          |
| `INTERNAL_API_KEY`           | Chave antiga compartilhada com o agente — **idêntica** nos dois `.env`; substituída pelas chaves por direção |
| `INTERNAL_API_KEY_AGENT_TO_API` / `INTERNAL_API_KEY_API_TO_AGENT` | Uma chave por direção da comunicação interna — **idênticas** nos dois `.env` |
| `WEB_URL`                    | Origem do frontend (CORS e links). Local: `http://localhost:3000`             |
| `AI_AGENT_URL`               | Base do agente (boas-vindas por WhatsApp no cadastro)                          |
| `BILLING_ENFORCEMENT_ENABLED`| `false` = não bloqueia usuários sem assinatura (útil em dev)                   |
| `ASAAS_API_URL` / `ASAAS_API_KEY` / `ASAAS_WEBHOOK_TOKEN` | Gateway de pagamento (sandbox em dev)             |
| `BILLING_CALLBACK_BASE_URL`  | URL pública para o retorno do checkout (o Asaas recusa `localhost`)            |
| `METRICS_TOKEN`              | Bearer do `/metrics` — mesmo valor no agente. Sem ele o endpoint fica fechado  |
| `LOKI_PUSH_URL`              | Envio de logs ao Alloy. Vazio em dev (sem Alloy)                               |
| `OPS_JWT_SECRET`             | Sessão do painel `/ops`. **Precisa ser diferente** de `JWT_SECRET`             |
| `OPS_GITHUB_ORG` / `OPS_GITHUB_CLIENT_ID` / `OPS_GITHUB_CLIENT_SECRET` | OAuth App do GitHub para login de operadores |
| `OPS_GITHUB_CALLBACK_URL` / `API_URL` | Callback do OAuth (vazio → `API_URL` + `/ops/auth/github/callback`)   |
| `OPS_BOOTSTRAP_ADMIN_GITHUB_LOGIN` | Login GitHub do **primeiro** `ops_admin` (ver [Painel de operações](#painel-de-operações-ops)) |
| `OPS_GRAFANA_URL` / `OPS_GRAFANA_LOKI_DATASOURCE_UID` | Links do painel para o Grafana. Vazios desligam a seção      |

O produto (web + WhatsApp) funciona sem Asaas, OAuth do GitHub e Grafana
configurados; só o checkout e o painel `/ops` dependem deles.

**Web** (`apps/web/.env.local`):

| Variável              | Descrição                              |
| --------------------- | -------------------------------------- |
| `NEXT_PUBLIC_API_URL` | URL da API (padrão: `http://localhost:3001`) |

**AI Agent** (`apps/ai-agent/.env`):

Núcleo:

| Variável                    | Padrão                     | Descrição                                                        |
| --------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `AI_AGENT_PORT`             | `8010`                     | Porta do agente                                                  |
| `ENVIRONMENT`               | `development`              | `development` \| `production` (ver [Produção](#rodando-em-produção)) |
| `LOG_LEVEL`                 | `INFO`                     | `DEBUG` \| `INFO` \| `WARNING` \| `ERROR`                        |
| `MAIN_API_URL`              | `http://localhost:3001`    | URL da API principal                                             |
| `WEB_URL`                   | `http://localhost:3000`    | Base do link de regularização da assinatura (em produção, a URL pública do web) |
| `INTERNAL_API_KEY`          | —                          | Chave antiga, igual à da API (aceita durante a migração)         |
| `INTERNAL_API_KEY_AGENT_TO_API` / `INTERNAL_API_KEY_API_TO_AGENT` | — | Chaves por direção, iguais às da API (header `x-internal-api-key`) |
| `LLM_PROVIDER`              | `rules`                    | `rules` (sem LLM) \| `openai`                                    |
| `OPENAI_API_KEY`            | —                          | Chave da OpenAI (necessária quando `LLM_PROVIDER=openai`)        |
| `OPENAI_MODEL`              | `gpt-4o-mini`              | Modelo usado na extração de intenção                             |
| `OPENAI_VISION_MODEL`       | —                          | Modelo para comprovantes/imagens (vazio → `OPENAI_MODEL`)        |
| `OPENAI_TRANSCRIPTION_MODEL`| `whisper-1`                | Transcrição de áudio                                             |
| `MEDIA_MAX_BYTES`           | `16777216`                 | Limite de download de mídia (16 MB)                              |
| `CONFIDENCE_THRESHOLD`      | `0.7`                      | Abaixo disso, o lançamento exige confirmação do usuário          |
| `CONVERSATION_TTL_MINUTES`  | `30`                       | TTL do estado de confirmação em memória                          |

Messenger (resposta ao usuário — ver [factory](apps/ai-agent/src/services/messenger/factory.py)):

| Variável                   | Padrão                              | Descrição                                                       |
| -------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| `WHATSAPP_PROVIDER`        | `log`                               | `log` (só registra em log, dev) \| `cloud-api` (envio real)     |
| `WHATSAPP_PROVIDER_TOKEN`  | —                                   | Token do WhatsApp Cloud API (obrigatório em `cloud-api`)        |
| `WHATSAPP_PHONE_NUMBER_ID` | —                                   | ID do número no WhatsApp Cloud API (obrigatório em `cloud-api`) |
| `WHATSAPP_API_BASE_URL`    | `https://graph.facebook.com/v18.0`  | Base da Graph API da Meta                                       |
| `WHATSAPP_WEBHOOK_SECRET`  | —                                   | App Secret da Meta; valida `X-Hub-Signature-256` (**obrigatório em produção**) |
| `WHATSAPP_VERIFY_TOKEN`    | —                                   | Token do handshake `GET` de verificação (igual ao "Verify token" do painel da Meta) |

> Com `ENVIRONMENT=production`, `WHATSAPP_PROVIDER=log` (ou `cloud-api` sem
> token/phone id) impede a subida do agente.

Pipeline de mensageria (broker durável):

| Variável                          | Padrão                                 | Descrição                                                                 |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `MESSAGE_PIPELINE`                | `broker`                               | `broker` (webhook publica em fila) \| `legacy` (buffer em processo, rollback) |
| `MESSAGE_BROKER`                  | `rabbitmq`                             | `rabbitmq` \| `inmemory` (dev sem Docker; **não é durável**)              |
| `RABBITMQ_URL`                    | `amqp://<user>:<senha>@localhost:5672/` | Conexão com o broker (credenciais de `infra/docker/.env`)                 |
| `RABBITMQ_INBOUND_QUEUE`          | `whatsapp.inbound.v1`                  | Fila das mensagens individuais                                             |
| `RABBITMQ_PROCESSING_QUEUE`       | `whatsapp.processing.v1`               | Fila dos jobs consolidados por telefone                                    |
| `RABBITMQ_PREFETCH`               | `10`                                   | Mensagens não ackadas entregues por canal de consumo                       |
| `INBOUND_CONSUMER_CONCURRENCY`    | `5`                                    | Jobs simultâneos no consumer de entrada                                    |
| `PROCESSING_CONSUMER_CONCURRENCY` | `3`                                    | Jobs simultâneos no consumer de processamento (limita chamadas à OpenAI)   |
| `MESSAGE_MAX_RETRIES`             | `5`                                    | Tentativas antes de mandar para a DLQ                                      |
| `MESSAGE_RETRY_BASE_SECONDS`      | `1.0`                                  | Base do backoff (`base * 2^tentativa`, com jitter)                         |
| `MESSAGE_RETRY_MAX_SECONDS`       | `300.0`                                | Teto do backoff                                                            |
| `RUN_CONSUMERS_IN_API`            | `true`                                 | `false` = a API só publica; consumo em `pnpm agent:worker`                 |
| `SHUTDOWN_DRAIN_SECONDS`          | `20.0`                                 | Espera pelo que está em voo antes de devolver à fila no shutdown           |
| `RUN_DLQ_CATALOG_CONSUMER`        | `true`                                 | Drena as DLQs para o catálogo de falhas no Postgres (painel `/ops`)        |
| `DLQ_CATALOG_PREFETCH`            | `5`                                    | Prefetch do consumer do catálogo                                           |
| `DLQ_USER_NOTICE_COOLDOWN_SECONDS`| `600`                                  | Janela do aviso ao usuário de mensagem não processada (`0` desliga)        |

Estado distribuído (Redis) — agrupamento, locks e estado de conversa:

| Variável                          | Padrão                     | Descrição                                                     |
| --------------------------------- | -------------------------- | ------------------------------------------------------------- |
| `REDIS_URL`                       | `redis://:<senha>@localhost:6379/0` | Conexão Redis (senha = `REDIS_PASSWORD` de `infra/docker/.env`) |
| `GROUP_STORE_BACKEND`             | `redis`                    | `redis` \| `memory` (agrupamento, locks e marcadores de job)  |
| `CONVERSATION_STATE_BACKEND`      | `redis`                    | `redis` \| `memory` (confirmações pendentes)                  |
| `CONVERSATION_STATE_TTL_SECONDS`  | `1800`                     | TTL da confirmação pendente                                    |
| `PROCESSING_LOCK_TTL_SECONDS`     | `120`                      | TTL do lock por telefone durante o processamento               |
| `JOB_DEDUPE_TTL_SECONDS`          | `86400`                    | Janela de deduplicação por `jobId`                             |
| `REDIS_LOCK_TTL_SECONDS`          | `30`                       | TTL do lock durante a consolidação do grupo                    |
| `WORKER_POLL_INTERVAL_SECONDS`    | `1.0`                      | Intervalo de polling do worker de agrupamento                  |

Agrupamento (debounce) de mensagens fragmentadas:

| Variável                            | Padrão   | Descrição                                                        |
| ----------------------------------- | -------- | ---------------------------------------------------------------- |
| `MESSAGE_BUFFER_DEBOUNCE_SECONDS`   | `5`      | Janela de espera para agrupar mensagens do mesmo telefone        |
| `MESSAGE_BUFFER_MAX_MESSAGES`       | `10`     | Consolida imediatamente ao atingir N mensagens na janela         |
| `MESSAGE_BUFFER_MAX_AGE_SECONDS`    | `30`     | Idade máxima do grupo, contada da **primeira** mensagem          |
| `CONVERSATION_CONTEXT_MESSAGE_LIMIT`| `15`     | Máximo de mensagens de histórico enviadas ao LLM                 |
| `CONVERSATION_CONTEXT_MAX_CHARS`    | `4000`   | Limite de caracteres do prompt de contexto                       |
| `MESSAGE_MAX_CHARS`                 | `2000`   | Tamanho máximo de uma mensagem recebida (acima disso não é processada e o usuário recebe resposta com o limite) |

Somente para `MESSAGE_PIPELINE=legacy` (buffer em processo, será removido):

| Variável                            | Padrão   | Descrição                                          |
| ----------------------------------- | -------- | -------------------------------------------------- |
| `MESSAGE_BUFFER_BACKEND`            | `memory` | `memory` \| `redis`                                |
| `MESSAGE_BUFFER_MAX_RETRIES`        | `3`      | Tentativas antes de ir para a DLQ do buffer antigo |
| `MESSAGE_BUFFER_RETRY_BASE_SECONDS` | `1.0`    | Base do backoff do buffer antigo                   |

Observabilidade:

| Variável              | Padrão                    | Descrição                                                              |
| --------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `METRICS_TOKEN`       | `local-dev-metrics-token` | Bearer do `/metrics` e `/metrics.json` — mesmo valor da API            |
| `WORKER_METRICS_PORT` | `8011`                    | Porta do HTTP mínimo do worker (`/metrics`, `/health/*`)               |
| `LOKI_PUSH_URL`       | —                         | Envio de logs ao Alloy (só o endereço base). Vazio em dev              |

### 3. Iniciar a infraestrutura local

```bash
pnpm db:up   # PostgreSQL (porta 5433) + RabbitMQ (5672/15672/15692) + Redis (6379)
```

Aguarde os três containers ficarem saudáveis:

```bash
docker compose -f infra/docker/docker-compose.yml ps
# financial-vellun-db         Up (healthy)
# financial-vellun-rabbitmq   Up (healthy)
# financial-vellun-redis      Up (healthy)
```

O painel do RabbitMQ fica em http://localhost:15672, e é por
onde você inspeciona filas, retries e DLQ. Usuário e senha vêm de
`RABBITMQ_USER`/`RABBITMQ_PASSWORD` em `infra/docker/.env`.


### 4. Gerar o client do Prisma, criar as tabelas e popular dados iniciais

```bash
# Gerar o Prisma Client (o `pnpm install` na raiz não encontra o schema e
# deixa o client sem gerar — sem isto a API falha com
# "@prisma/client did not initialize yet")
pnpm prisma:generate

# Rodar as migrations
pnpm --filter @financial-vellun/api exec prisma migrate deploy

# Popular categorias padrão (individual + business) e o usuário demo
pnpm prisma:seed
```

O seed também cria um usuário demo para desenvolvimento:

```txt
Email: vellunsolutions2026@gmail.com
Senha: qwerty123
```

> Para resetar o banco em desenvolvimento: `pnpm --filter @financial-vellun/api exec prisma migrate reset`

### 5. Configurar o agente de IA (Python)

> **Atenção (Windows × Linux/macOS):** o caminho do Python dentro da venv muda
> conforme o sistema operacional. No Windows é `.venv\Scripts\python.exe`; no
> Linux/macOS é `.venv/bin/python`. No bash do Linux/macOS as barras invertidas
> (`\`) são removidas, então copiar o comando do Windows resulta no erro
> `.venvScriptspython.exe: comando não encontrado`. Use sempre a coluna do seu SO.

```bash
cd apps/ai-agent

# Criar ambiente virtual na primeira configuracao
python -m venv .venv

# Se a pasta .venv ja existir, nao recrie por cima.
# Use a venv existente ou pare os processos Python/uvicorn antes de remove-la e recria-la.
```

Instalar dependencias usando o Python da propria venv:

```bash
# Windows
.venv\Scripts\python.exe -m pip install -e .

# Linux/macOS
.venv/bin/python -m pip install -e .
```

Redis e RabbitMQ (`redis`, `aio-pika`) já fazem parte das dependências
obrigatórias — o extra `[redis]` existe só por compatibilidade.

Para rodar os testes, instale também o grupo `dev` (pytest). O `--group` exige
pip ≥ 25.1, por isso a atualização do pip antes:

```bash
# Windows
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install --group dev

# Linux/macOS
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install --group dev
```

A ativacao manual da venv e opcional. Ela so e necessaria quando voce quiser executar comandos Python diretamente dentro de `apps/ai-agent`, como `pytest`, `python` ou `pip`.

```bash
# Ativar manualmente no Windows, se necessario
.venv\Scripts\activate

# Ativar manualmente no macOS/Linux, se necessario
source .venv/bin/activate
```

Para iniciar o agente pelo monorepo, nao precisa ativar a venv manualmente. Os scripts `pnpm agent:dev`, `pnpm agent:worker` e `pnpm test:agent` usam [run-python.mjs](apps/ai-agent/scripts/run-python.mjs), que escolhe `.venv\Scripts\python.exe` (Windows) ou `.venv/bin/python` (Linux/macOS) e avisa se a venv não existir.

---

## Rodando o projeto

Tudo de uma vez (sobe a infra e os três serviços em paralelo):

```bash
pnpm dev
```

Ou um terminal para cada serviço:

```bash
# Terminal 1 — API (porta 3001)
pnpm api:dev

# Terminal 2 — Web (porta 3000)
pnpm web:dev

# Terminal 3 — Agente de IA (porta 8010)
pnpm agent:dev
```

| Serviço            | URL                                 |
| ------------------ | ----------------------------------- |
| Web                | http://localhost:3000               |
| Painel de operações| http://localhost:3000/ops           |
| API                | http://localhost:3001               |
| Swagger            | http://localhost:3001/api/docs      |
| AI Agent           | http://localhost:8010               |
| Painel do RabbitMQ | http://localhost:15672 (`RABBITMQ_USER`/`RABBITMQ_PASSWORD`) |

Health e métricas — o mesmo trio nos três processos. `/metrics` exige o header
`Authorization` com o `METRICS_TOKEN` configurado nos `.env`:

| Serviço           | Liveness / Readiness                        | Métricas                          |
| ----------------- | ------------------------------------------- | --------------------------------- |
| API               | `:3001/health/live` · `:3001/health/ready`  | `:3001/metrics`                   |
| AI Agent          | `:8010/health/live` · `:8010/health/ready`  | `:8010/metrics` · `/metrics.json` |
| AI Agent (worker) | `:8011/health/live` · `:8011/health/ready`  | `:8011/metrics` · `/metrics.json` |

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3001/metrics
```

> O `pnpm dev` sobe os consumers junto com o agente (`RUN_CONSUMERS_IN_API=true`).
> Para escalar o processamento separadamente, use `RUN_CONSUMERS_IN_API=false` e
> `pnpm agent:worker`.

Login no app com o usuário demo do seed (credenciais acima). Para não esbarrar
na exigência de assinatura em dev, use `BILLING_ENFORCEMENT_ENABLED=false` em
`apps/api/.env`.

### Painel de operações (`/ops`)

O `/ops` usa identidade própria (GitHub OAuth + pertencer a `OPS_GITHUB_ORG`),
separada dos usuários do produto. Para usá-lo num ambiente novo:

1. Crie um OAuth App no GitHub (Settings → Developer settings → OAuth Apps) com
   callback `http://localhost:3001/ops/auth/github/callback` e preencha
   `OPS_GITHUB_CLIENT_ID` / `OPS_GITHUB_CLIENT_SECRET`.
2. Defina `OPS_JWT_SECRET` com um valor **diferente** de `JWT_SECRET`.
3. Todo primeiro login nasce `viewer` inativo. Para criar o primeiro
   `ops_admin`, defina `OPS_BOOTSTRAP_ADMIN_GITHUB_LOGIN=<seu-login>` antes do
   primeiro login — só tem efeito com a tabela `ops_operators` vazia; depois pode
   ser removida.

### Observabilidade local (opcional)

```bash
pnpm obs:up      # infra + Alloy + exporters de Postgres e Redis
pnpm obs:check   # valida configs do Alloy, regras de alerta e PromQL dos dashboards
```

Detalhes (usuário de monitoramento do Postgres, alvos, envio ao Grafana Cloud)
em [infra/observability/README.md](infra/observability/README.md) e
[docs/observability.md](docs/observability.md#verificação-local).

---

## Arquitetura de processamento de mensagens (WhatsApp + IA)

O fluxo foi desenhado para o uso real do WhatsApp, onde o usuário fragmenta uma
instrução em várias mensagens curtas ("gastei" / "47,50" / "no mercado") e
responde a perguntas anteriores ("Nubank"). O webhook **só recebe e publica**;
todo o resto roda em consumers, fora do ciclo HTTP.

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

1. **Webhook** ([webhook.py](apps/ai-agent/src/routers/webhook.py)) — lê o corpo
   bruto, valida `X-Hub-Signature-256`, normaliza o payload e publica cada
   mensagem em `whatsapp.inbound.v1`. Responde `202 Accepted` **depois** do
   *publisher confirm*, ou `503` se não puder garantir a publicação. Não chama a
   API principal, o banco, a OpenAI, nem baixa mídia.
2. **Consumer de entrada** ([inbound_consumer.py](apps/ai-agent/src/consumers/inbound_consumer.py))
   — persiste a `AiMessage` de forma idempotente, baixa e transcreve áudio /
   aplica visão em comprovantes, e grava o texto no agrupamento por telefone.
3. **Agrupamento** ([grouping/](apps/ai-agent/src/grouping/)) — debounce de 5 s,
   no máximo 10 mensagens, idade máxima de 30 s, com lock distribuído por
   telefone. Publica a mensagem consolidada em `whatsapp.processing.v1` e só
   limpa o buffer **depois** do confirm.
4. **Consumer de processamento** ([processing_consumer.py](apps/ai-agent/src/consumers/processing_consumer.py))
   — resolve contato, valida assinatura, monta o contexto, classifica a
   intenção, cria o lançamento (ou pede confirmação) e responde ao usuário.
5. **Estado de conversa** — confirmações pendentes ficam no Redis com TTL, então
   sobrevivem a restart e funcionam entre instâncias.

### Filas

| Fila | Papel |
| ---- | ----- |
| `whatsapp.inbound.v1` | mensagens individuais publicadas pelo webhook |
| `whatsapp.processing.v1` | mensagens já consolidadas por telefone |
| `whatsapp.{inbound,processing}.retry.{1,4,16,60,300}s` | buckets de retry com TTL e dead-letter de volta à fila de origem |
| `whatsapp.{inbound,processing}.dlq` | falhas permanentes ou tentativas esgotadas |

Tudo é declarado `durable`, as mensagens são publicadas como persistentes e o
consumo usa ack manual: uma mensagem só é ackada quando o efeito da etapa está
duravelmente concluído.

### Idempotência

| Nível             | Chave                                  | Onde                                                 |
| ----------------- | -------------------------------------- | ---------------------------------------------------- |
| Entrada           | `providerMessageId`                    | `ai_messages.provider_message_id` (único)            |
| Job consolidado   | `jobId` derivado de `sourceMessageIds` | marcador `job:done:{jobId}` no Redis                 |
| Efeitos no banco  | `idempotencyKey` (= `jobId`)           | `transactions.idempotency_key` e                     |
|                   |                                        | `ai_extracted_transactions.idempotency_key` (únicos) |

Os três são necessários: um timeout **depois** de a escrita ter acontecido só é
coberto pelo terceiro nível, no banco. Deduplicar também a extração é o que
impede que o retry deixe uma `AiExtractedTransaction` órfã — a criação do
lançamento é deduplicada antes e não chegaria a vinculá-la.

### Publicar uma mensagem de teste

```bash
# Payload simplificado de desenvolvimento
curl -i -X POST http://localhost:8010/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{"phone":"+5541999999999","message":"gastei 47,50 no mercado","message_id":"wamid.teste-1"}'
# esperado: HTTP/1.1 202 Accepted  {"status":"accepted","published":1}
```

Com `WHATSAPP_WEBHOOK_SECRET` configurado, a assinatura é obrigatória:

```bash
BODY='{"phone":"+5541999999999","message":"gastei 10","message_id":"wamid.teste-2"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WHATSAPP_WEBHOOK_SECRET" | awk '{print $2}')
curl -i -X POST http://localhost:8010/webhook/whatsapp \
  -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$SIG" -d "$BODY"
```

Acompanhe o caminho da mensagem em http://localhost:15672 e em
`GET /metrics`.

### Runbook: DLQ, retries e reprocesso

Ver [docs/whatsapp-messaging-runbook.md](docs/whatsapp-messaging-runbook.md).
As decisões arquiteturais e o porquê de cada uma estão em
[docs/adrs/](docs/adrs/README.md).

### Rodando sem Docker

Para desenvolver sem RabbitMQ e sem Redis, todo o pipeline roda em um processo:

```bash
MESSAGE_BROKER=inmemory
GROUP_STORE_BACKEND=memory
CONVERSATION_STATE_BACKEND=memory
```

**Não é durável** — nada sobrevive a restart. Use apenas em desenvolvimento.

### Rollback para o caminho antigo

`MESSAGE_PIPELINE=legacy` reativa o buffer em processo
([message_buffer.py](apps/ai-agent/src/services/message_buffer.py)), sem broker.
Serve como rede de segurança por uma release; ver
[ADR 0009](docs/adrs/0009-rollout-por-flag-message-pipeline.md).

---

## Rodando em produção

### 1. Variáveis de ambiente

```bash
# API — além das variáveis de apps/api/.env.example com valores reais
NODE_ENV=production            # cookies seguros e log JSON estruturado
PORT=3001

# AI Agent
ENVIRONMENT=production
WHATSAPP_WEBHOOK_SECRET=<segredo-forte>
WHATSAPP_PROVIDER=cloud-api
WHATSAPP_PROVIDER_TOKEN=<token-da-meta>
WHATSAPP_PHONE_NUMBER_ID=<phone-number-id>
WHATSAPP_VERIFY_TOKEN=<token-do-handshake>
LLM_PROVIDER=openai
OPENAI_API_KEY=<chave>

# Pipeline de mensageria
MESSAGE_PIPELINE=broker
MESSAGE_BROKER=rabbitmq
RABBITMQ_URL=amqp://<user>:<senha>@<host>:5672/
RABBITMQ_PREFETCH=10
INBOUND_CONSUMER_CONCURRENCY=5
PROCESSING_CONSUMER_CONCURRENCY=3
MESSAGE_MAX_RETRIES=5
MESSAGE_RETRY_BASE_SECONDS=1.0
MESSAGE_RETRY_MAX_SECONDS=300.0
RUN_CONSUMERS_IN_API=false     # consumo em processos dedicados
SHUTDOWN_DRAIN_SECONDS=20.0

# Estado distribuído
REDIS_URL=redis://<host>:6379/0
GROUP_STORE_BACKEND=redis
CONVERSATION_STATE_BACKEND=redis
CONVERSATION_STATE_TTL_SECONDS=1800
PROCESSING_LOCK_TTL_SECONDS=120
JOB_DEDUPE_TTL_SECONDS=86400
```

Em produção, `ENVIRONMENT=production` também troca o log para **JSON
estruturado** e passa a usar o **hash** do telefone (em vez da versão
mascarada) nos logs.

### 2. Banco de dados (migrations)

Use `migrate deploy` (nunca `migrate dev`/`reset` em produção):

```bash
pnpm --filter @financial-vellun/api exec prisma migrate deploy
```

### 3. Build dos serviços

```bash
# API (NestJS) → dist/
pnpm --filter @financial-vellun/api build
node apps/api/dist/main

# Web (Next.js)
pnpm --filter @financial-vellun/web build
pnpm --filter @financial-vellun/web start
```

### 4. Agente de IA: API e workers

```bash
cd apps/ai-agent
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt

# Processo que recebe os webhooks (RUN_CONSUMERS_IN_API=false: só publica)
.venv/bin/python -m uvicorn src.main:app --host 0.0.0.0 --port 8010

# Processos que consomem as filas — escale este independentemente
.venv/bin/python -m src.worker
```

Ambos encerram de forma graciosa: param de receber, aguardam o que está em voo
até `SHUTDOWN_DRAIN_SECONDS` e devolvem à fila o que não terminou. Nenhuma
mensagem confirmada se perde num deploy.

O `readiness` (`/health/ready`) falha com `503` quando o broker ou o Redis estão
fora — aponte o health check do orquestrador para ele, e o `liveness`
(`/health/live`) para o restart.

### 5. Observabilidade

- **Health:** `GET /health/live` (restart) e `GET /health/ready` (tráfego).
- **Métricas:** `GET /metrics` em formato Prometheus, com
  `Authorization: Bearer ${METRICS_TOKEN}`.
- Logs estruturados em cada etapa (webhook → buffer → flush → contato →
  histórico → LLM/fallback → intenção → confirmação → transação → resposta).
- **Coleta:** um serviço **Alloy** no mesmo projeto do Railway scrapa as métricas
  pela rede privada, recebe os logs que API e agente empurram e envia tudo ao
  Grafana Cloud. A imagem é [`Dockerfile.alloy`](Dockerfile.alloy), com o
  [`config.alloy`](infra/observability/alloy/config.alloy) copiado para dentro.

O Alloy encontra os serviços pelo nome (`financial-vellun-api`,
`financial-vellun-ai-agent`) e em porta fixa, então a API precisa de `PORT=3001` e
o agente de `PORT=8010`. Ordem: subir o Alloy → conferir os alvos `up` → só então
preencher `LOKI_PUSH_URL=http://alloy.railway.internal:3100` na API e no agente.
O passo a passo, as variáveis e as armadilhas (IPv6, alvos comentados) estão em
[docs/observability.md](docs/observability.md#produção-no-railway).

---

## Testes

```bash
# Tudo (API + agente)
pnpm test

# API (Jest + ts-jest)
pnpm --filter @financial-vellun/api test

# Agente de IA (pytest) — exige o grupo `dev` instalado (ver passo 5)
pnpm test:agent

# Testes de integração do agente (RabbitMQ + Redis reais) ficam de fora por
# padrão; rode-os depois de `pnpm db:up`, a partir de apps/ai-agent:
# Windows
cd apps/ai-agent && .venv\Scripts\python.exe -m pytest -m integration -q
# Linux/macOS
cd apps/ai-agent && .venv/bin/python -m pytest -m integration -q
```

---

## Scripts disponíveis

| Comando              | Descrição                                    |
| -------------------- | -------------------------------------------- |
| `pnpm dev`           | Sobe a infra + API + Web + agente em paralelo |
| `pnpm db:up` / `pnpm infra:up`     | Sobe PostgreSQL + RabbitMQ + Redis via Docker |
| `pnpm db:down` / `pnpm infra:down` | Para os containers de infraestrutura          |
| `pnpm api:dev`       | Inicia a API em modo desenvolvimento         |
| `pnpm web:dev`       | Inicia o frontend em modo desenvolvimento    |
| `pnpm agent:dev`     | Inicia o agente de IA (HTTP, porta 8010)     |
| `pnpm agent:worker`  | Só os consumers das filas (sem HTTP)         |
| `pnpm prisma:generate` | Gera o Prisma Client                       |
| `pnpm prisma:migrate`  | `prisma migrate dev` (cria migration em dev) |
| `pnpm prisma:seed`     | Categorias padrão + usuário demo           |
| `pnpm prisma:studio`   | Abre o Prisma Studio                       |
| `pnpm test`          | Testes da API (Jest) + agente (pytest)       |
| `pnpm test:agent`    | Só os testes do agente                       |
| `pnpm typecheck`     | `tsc --noEmit` na API                        |
| `pnpm lint`          | ESLint em todo o repo                        |
| `pnpm format`        | Formata todos os arquivos com Prettier       |
| `pnpm format:check`  | Verifica a formatação sem alterar arquivos   |
| `pnpm obs:up` / `pnpm obs:down` | Infra + stack local de observabilidade |
| `pnpm obs:check`     | Valida Alloy, regras de alerta e dashboards  |

> **Banco/Prisma:** aplicar migrations com `pnpm --filter @financial-vellun/api exec prisma migrate deploy`; resetar em dev com `pnpm --filter @financial-vellun/api exec prisma migrate reset`.

---

## Testando pagamentos no sandbox do Asaas

O ambiente sandbox usa **cartões fictícios** — nunca use dados reais em
homologação. O checkout só abre se o cliente tiver telefone + endereço completos
e CPF/CNPJ com dígito verificador válido, e se `BILLING_CALLBACK_BASE_URL`
apontar para uma URL pública (o Asaas recusa `localhost` — ver
[Problemas comuns](#checkout-do-asaas-retorna-400-successurlcancelurl-inválidos)).

**Cartão que simula aprovação** ✅

| Campo    | Valor                                  |
| -------- | -------------------------------------- |
| Número   | `4444 4444 4444 4444`                  |
| Validade | qualquer data **futura** (ex.: `12/2030`) |
| CVV      | `123` (ou qualquer 3 dígitos)          |

**Cartões que simulam recusa/falha** ❌

| Bandeira   | Número                |
| ---------- | --------------------- |
| Mastercard | `5184 0197 4037 3151` |
| Visa       | `4916 5613 5824 0741` |

**Dados do titular:** use dados fictícios. Se o checkout pedir CPF do titular,
informe um CPF com dígito verificador válido (ex.: `249.715.637-92`); um CPF
"fake" como `111.111.111-11` é recusado. Para gerar mais cartões válidos, o
Asaas sugere geradores como o 4Devs.

Fluxo de homologação: criar cliente → criar cobrança com cartão → resposta da
API → webhook de pagamento → atualizar status. Teste tanto o cenário de sucesso
quanto o de recusa. Referência:
[Testing Credit Card Payment — Asaas Docs](https://docs.asaas.com/docs/testing-credit-card-payment).

---

## Problemas comuns

### Checkout do Asaas retorna `400` (`successUrl`/`cancelUrl` inválidos)

O Asaas **recusa URLs `localhost`** nos redirects do checkout. Em
desenvolvimento, defina `BILLING_CALLBACK_BASE_URL` em `apps/api/.env` com uma
URL pública (ex.: um túnel `https://SEU-ID.ngrok-free.app`) — `WEB_URL`
continua `http://localhost:3000` para o restante do app. Sem isso, a abertura do
checkout falha.

Outros `400` na criação do cliente costumam ser dados recusados pelo Asaas
(ex.: *"O CPF/CNPJ informado é inválido."*): o cadastro agora valida o dígito
verificador, e a mensagem do Asaas é repassada ao usuário.

### `pnpm db:up` falha com `env file ... infra/docker/.env not found`

Falta o `.env` da infraestrutura: `cp infra/docker/.env.example infra/docker/.env`.

### API falha com `@prisma/client did not initialize yet`

O Prisma Client não foi gerado. Rode `pnpm prisma:generate` (com a API parada,
ver o item de `EPERM` abaixo).

### `No module named pytest` ao rodar os testes do agente

O grupo `dev` não foi instalado: `python -m pip install --upgrade pip` e depois
`python -m pip install --group dev`, usando o Python da venv (passo 5).

### Porta da API em uso

Se `pnpm dev` falhar com `EADDRINUSE` na porta `3001`, ja existe outro processo usando a porta da API. No Windows, encontre e encerre o processo:

```powershell
netstat -ano | findstr :3001
taskkill /PID <PID> /F
```

Outra opcao e alterar `API_PORT` em `apps/api/.env` e atualizar `NEXT_PUBLIC_API_URL` em `apps/web/.env.local` para a mesma porta.

### `prisma generate` falha com `EPERM` no Windows

O erro `EPERM: operation not permitted, rename ...query_engine-windows.dll.node`
ocorre quando há um processo Prisma ativo (a API rodando via `pnpm dev`)
segurando o binário do query engine, ou o OneDrive sincronizando a pasta.
Pare a API antes de rodar `prisma generate`/`migrate`, ou feche os processos
Node que estejam usando o client.

### Webhook do agente retorna `401`

Em `ENVIRONMENT=production`, o `WHATSAPP_WEBHOOK_SECRET` é obrigatório e a
requisição precisa do header `X-Hub-Signature-256: sha256=<hex>` (HMAC-SHA256 do
corpo; `X-Webhook-Signature` também é aceito, por compatibilidade com o formato
simulado). Em desenvolvimento, sem o secret configurado, o webhook aceita sem
assinatura.

---

## Fases de implementação

| Fase | Status | Escopo |
| ---- | ------ | ------ |
| **1 — Fundação** | ✅ Completo | Monorepo, schema Prisma, bootstrap apps, Docker |
| **2 — Produto Pessoal** | ✅ Completo | Auth JWT, perfis, CRUD de contas/categorias/lançamentos, dashboard |
| **3 — IA e WhatsApp** | 🚧 Em andamento | Webhook, extração de intenção, integração LLM, pipeline durável (RabbitMQ + Redis) (ver [arquitetura](#arquitetura-de-processamento-de-mensagens-whatsapp--ia)) |
| **4 — Pessoa Jurídica** | 🚧 Em andamento | Dashboard empresarial, contas a pagar/receber, clientes/fornecedores, categorias |
| **5 — Evolução (pós-MVP)** | 🚧 Em andamento | Recorrências, metas de gastos, caixinhas, cartões, lembretes, agenda, anotações, membros (Duo), análise financeira; pendentes: relatórios e importação de extratos |

---

## Documentação

- [ADRs — decisões arquiteturais](docs/adrs/README.md)
- [Runbook do pipeline WhatsApp](docs/whatsapp-messaging-runbook.md)
- [Observabilidade](docs/observability.md) · [arquivos versionados](infra/observability/README.md)
- [Rollout do billing](docs/billing-rollout.md)
- [Requisitos técnicos](docs/technical-requirements.md)
- [Prompts de implementação](docs/implementation-prompts.md)
- [Requisitos — processamento assíncrono WhatsApp/IA](docs/whatsapp-ai-async-processing-requirements.md)
- [Plano — processamento assíncrono WhatsApp/IA](plan/whatsapp-ai-async-processing-plan.md)
- [Swagger da API](http://localhost:3001/api/docs) *(com o servidor rodando)*
