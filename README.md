# Financial Vellun

Aplicação de controle financeiro para pessoa física e jurídica, com lançamentos via WhatsApp usando agente de IA.

## Estrutura do monorepo

```
financial-vellun/
  apps/
    web/        # Frontend — Next.js 14 + Tailwind CSS + shadcn/ui
    api/        # API principal — NestJS + Prisma + PostgreSQL
    ai-agent/   # Agente de IA — Python + FastAPI
  packages/
    shared/     # Tipos, enums e schemas Zod compartilhados
    config/     # Configurações de TS, ESLint e Prettier
  infra/
    docker/     # Docker Compose com PostgreSQL
  docs/
    technical-requirements.md
    implementation-prompts.md
```

## Pré-requisitos

| Ferramenta    | Versão mínima | Verificar                  |
| ------------- | ------------- | -------------------------- |
| Node.js       | 20            | `node -v`                  |
| pnpm          | 9             | `pnpm -v`                  |
| Python        | 3.11          | `python --version`         |
| Docker Desktop| qualquer      | `docker -v`                |

---

## Configuração inicial (primeira vez)

### 1. Instalar dependências Node

```bash
pnpm install
```

### 2. Configurar variáveis de ambiente

Copie os arquivos de exemplo e preencha os valores:

**API** (`apps/api/`):
```bash
cp apps/api/.env.example apps/api/.env
```

| Variável              | Descrição                                         |
| --------------------- | ------------------------------------------------- |
| `DATABASE_URL`        | URL de conexão com o PostgreSQL                   |
| `JWT_SECRET`          | Segredo para assinar os access tokens (≥ 32 chars)|
| `JWT_REFRESH_SECRET`  | Segredo para os refresh tokens (≥ 32 chars)       |
| `API_PORT`            | Porta da API (padrão: `3001`)                     |
| `INTERNAL_API_KEY`    | Chave compartilhada entre API e agente de IA      |

**Web** (`apps/web/`):
```bash
cp apps/web/.env.local.example apps/web/.env.local
```

| Variável              | Descrição                              |
| --------------------- | -------------------------------------- |
| `NEXT_PUBLIC_API_URL` | URL da API (padrão: `http://localhost:3001`) |

**AI Agent** (`apps/ai-agent/`):
```bash
cp apps/ai-agent/.env.example apps/ai-agent/.env
```

Núcleo:

| Variável                  | Padrão                     | Descrição                                                        |
| ------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `AI_AGENT_PORT`           | `8010`                     | Porta do agente                                                  |
| `ENVIRONMENT`             | `development`              | `development` \| `production` (ver [Produção](#rodando-em-produção)) |
| `MAIN_API_URL`            | `http://localhost:3001`    | URL da API principal                                             |
| `INTERNAL_API_KEY`        | —                          | Mesma chave configurada na API (header `x-internal-api-key`)     |
| `LLM_PROVIDER`            | `rules`                    | `rules` (sem LLM) \| `openai`                                    |
| `OPENAI_API_KEY`          | —                          | Chave da OpenAI (necessária quando `LLM_PROVIDER=openai`)        |
| `OPENAI_MODEL`            | `gpt-4o-mini`              | Modelo usado na extração de intenção                             |
| `CONFIDENCE_THRESHOLD`    | `0.7`                      | Abaixo disso, o lançamento exige confirmação do usuário          |
| `CONVERSATION_TTL_MINUTES`| `30`                       | TTL do estado de confirmação em memória                          |

Messenger (resposta ao usuário — ver [factory](apps/ai-agent/src/services/messenger/factory.py)):

| Variável                   | Padrão                              | Descrição                                                       |
| -------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| `WHATSAPP_PROVIDER`        | `log`                               | `log` (só registra em log, dev) \| `cloud-api` (envio real)     |
| `WHATSAPP_PROVIDER_TOKEN`  | —                                   | Token do WhatsApp Cloud API (obrigatório em `cloud-api`)        |
| `WHATSAPP_PHONE_NUMBER_ID` | —                                   | ID do número no WhatsApp Cloud API (obrigatório em `cloud-api`) |
| `WHATSAPP_API_BASE_URL`    | `https://graph.facebook.com/v18.0`  | Base da Graph API da Meta                                       |
| `WHATSAPP_WEBHOOK_SECRET`  | —                                   | Segredo HMAC-SHA256 para validar webhooks (**obrigatório em produção**) |

Buffer / debounce de mensagens fragmentadas:

| Variável                            | Padrão   | Descrição                                                        |
| ----------------------------------- | -------- | ---------------------------------------------------------------- |
| `MESSAGE_BUFFER_BACKEND`            | `memory` | `memory` (dev/single-instance) \| `redis` (produção/multi-instância) |
| `MESSAGE_BUFFER_DEBOUNCE_SECONDS`   | `5`      | Janela de espera para agrupar mensagens do mesmo telefone        |
| `MESSAGE_BUFFER_MAX_MESSAGES`       | `10`     | Flush imediato ao atingir N mensagens na janela                  |
| `MESSAGE_BUFFER_MAX_AGE_SECONDS`    | `30`     | Idade máxima da janela antes do flush forçado                    |
| `CONVERSATION_CONTEXT_MESSAGE_LIMIT`| `15`     | Máximo de mensagens de histórico enviadas ao LLM                 |
| `CONVERSATION_CONTEXT_MAX_CHARS`    | `4000`   | Limite de caracteres do prompt de contexto                       |
| `MESSAGE_MAX_CHARS`                 | `2000`   | Tamanho máximo de uma mensagem recebida (webhook rejeita acima)  |

Redis / fila distribuída (apenas quando `MESSAGE_BUFFER_BACKEND=redis`):

| Variável                            | Padrão                      | Descrição                                          |
| ----------------------------------- | --------------------------- | -------------------------------------------------- |
| `REDIS_URL`                         | `redis://localhost:6379/0`  | Conexão Redis                                      |
| `REDIS_LOCK_TTL_SECONDS`            | `30`                        | TTL do lock distribuído por telefone               |
| `WORKER_POLL_INTERVAL_SECONDS`      | `1.0`                       | Intervalo de polling do worker de flush            |
| `MESSAGE_BUFFER_MAX_RETRIES`        | `3`                         | Tentativas de processamento antes de ir para a DLQ |
| `MESSAGE_BUFFER_RETRY_BASE_SECONDS` | `1.0`                       | Base do backoff exponencial entre tentativas       |

### 3. Iniciar o banco de dados

```bash
pnpm db:up
```

Aguarde o container ficar saudável (`docker ps` deve mostrar `healthy`).

### 4. Criar as tabelas e popular dados iniciais

```bash
# Rodar as migrations
pnpm --filter @financial-vellun/api exec prisma migrate deploy

# Popular categorias padrão (individual + business)
pnpm --filter @financial-vellun/api db:seed
```

O seed tambem cria um usuario demo para desenvolvimento:

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

Em produção com backend Redis, instale também o extra:

```bash
# Windows
.venv\Scripts\python.exe -m pip install -e .[redis]

# Linux/macOS
.venv/bin/python -m pip install -e '.[redis]'
```

A ativacao manual da venv e opcional. Ela so e necessaria quando voce quiser executar comandos Python diretamente dentro de `apps/ai-agent`, como `pytest`, `python` ou `pip`.

```bash
# Ativar manualmente no Windows, se necessario
.venv\Scripts\activate

# Ativar manualmente no macOS/Linux, se necessario
source .venv/bin/activate
```

Para iniciar o agente pelo monorepo, nao precisa ativar a venv manualmente. O script `pnpm agent:dev` cuida disso (no Windows usa `.venv\Scripts\python.exe`; no Linux/macOS, `.venv/bin/python`).

---

## Rodando o projeto

Abra um terminal para cada serviço:

```bash
# Terminal 1 — API (porta 3001)
pnpm api:dev

# Terminal 2 — Web (porta 3000)
pnpm web:dev

# Terminal 3 — Agente de IA (porta 8010)
pnpm agent:dev
```

| Serviço    | URL                                      |
| ---------- | ---------------------------------------- |
| Web        | http://localhost:3000                    |
| API        | http://localhost:3001                    |
| Swagger    | http://localhost:3001/api/docs           |
| AI Agent   | http://localhost:8010                    |
| Health     | http://localhost:8010/health             |
| Métricas   | http://localhost:8010/metrics            |

---

## Arquitetura de processamento de mensagens (WhatsApp + IA)

O fluxo do agente foi desenhado para o uso real do WhatsApp, onde o usuário
fragmenta uma instrução em várias mensagens curtas ("gastei" / "47,50" /
"no mercado") e responde a perguntas anteriores ("Nubank").

```
Webhook  ──►  Buffer/Debounce  ──►  Worker/Processor  ──►  IA (LLM + histórico)  ──►  Lançamento
(valida +     (agrupa por           (consolida e           (contexto: categorias,     (cria via API
 bufferiza)    telefone, debounce)   processa fora          contas, histórico recente)  interna)
                                     do request)
```

1. **Ingestão rápida** — `POST /webhook/whatsapp` valida assinatura/payload,
   persiste a mensagem inbound, enfileira no buffer e responde
   `{"status":"accepted"}` imediatamente. Nenhuma chamada de IA acontece no
   request. Ver [webhook.py](apps/ai-agent/src/routers/webhook.py).
2. **Buffer/debounce por telefone** — mensagens do mesmo número são agrupadas
   numa janela (`MESSAGE_BUFFER_DEBOUNCE_SECONDS`); o flush ocorre por debounce,
   por `MAX_MESSAGES` ou por `MAX_AGE`. Telefones distintos são isolados por lock.
   Ver [message_buffer.py](apps/ai-agent/src/services/message_buffer.py).
3. **Processamento assíncrono** — o [message_processor.py](apps/ai-agent/src/services/message_processor.py)
   consolida as mensagens, resolve o contato, classifica a intenção, cria o
   lançamento (ou pede confirmação) e envia a resposta via `messenger`.
4. **Contexto conversacional** — a IA recebe o histórico recente da conversa
   (via `GET /internal/whatsapp/contacts/:phone/messages`) para interpretar
   respostas curtas e correções. Ver [conversation_history_service.py](apps/ai-agent/src/services/conversation_history_service.py).
5. **Idempotência** — `providerMessageId` é único em `ai_messages`; o reenvio do
   mesmo webhook não duplica mensagem nem lançamento.

**Backends de buffer:**

- `memory` (padrão) — `asyncio` em processo único. Ideal para desenvolvimento.
  Não sobrevive a restart e não suporta múltiplas instâncias.
- `redis` — buffer/lock distribuídos + worker com **retry/backoff e DLQ**.
  Necessário em produção com mais de uma instância. Ver [redis_buffer.py](apps/ai-agent/src/services/redis_buffer.py).

---

## Rodando em produção

### 1. Variáveis de ambiente

```bash
# AI Agent
ENVIRONMENT=production
WHATSAPP_WEBHOOK_SECRET=<segredo-forte>        # obrigatório: webhooks sem assinatura válida são rejeitados (401)
WHATSAPP_PROVIDER=cloud-api
WHATSAPP_PROVIDER_TOKEN=<token-do-cloud-api>
WHATSAPP_PHONE_NUMBER_ID=<phone-number-id>
MESSAGE_BUFFER_BACKEND=redis
REDIS_URL=redis://<host>:6379/0
LLM_PROVIDER=openai
OPENAI_API_KEY=<chave>
```

Em produção (`ENVIRONMENT=production`) o `WHATSAPP_WEBHOOK_SECRET` é
**obrigatório** — sem ele o webhook recusa todas as requisições. Tokens e
chaves nunca são gravados em log.

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

### 4. Agente de IA com Redis

O backend Redis exige o pacote opcional `redis`:

```bash
cd apps/ai-agent

# Windows
.venv\Scripts\python.exe -m pip install -e .[redis]
# Servir com uvicorn (sem --reload em produção; ajuste workers conforme a carga)
.venv\Scripts\python.exe -m uvicorn src.main:app --host 0.0.0.0 --port 8010

# Linux/macOS
.venv/bin/python -m pip install -e '.[redis]'
.venv/bin/python -m uvicorn src.main:app --host 0.0.0.0 --port 8010
```

O worker do buffer Redis é iniciado/encerrado automaticamente pelo ciclo de
vida da aplicação ([main.py](apps/ai-agent/src/main.py)). Jobs que falham após
`MESSAGE_BUFFER_MAX_RETRIES` vão para a lista `dlq` no Redis.

### 5. Observabilidade

- **Health:** `GET /health`
- **Métricas:** `GET /metrics` — contadores (webhooks recebidos, mensagens
  processadas, lançamentos criados, fallback de LLM, duplicatas, DLQ) e
  latências médias (recebimento→processamento, LLM). Ver [metrics.py](apps/ai-agent/src/services/metrics.py).
- Logs estruturados em cada etapa (webhook → buffer → flush → contato →
  histórico → LLM/fallback → intenção → confirmação → transação → resposta).

> O coletor de métricas é **em memória por processo**. Com múltiplas instâncias,
> exporte para Prometheus/StatsD (fora do escopo do MVP).

---

## Testes

```bash
# API (Jest + ts-jest)
pnpm --filter @financial-vellun/api test

# Agente de IA (pytest) — a partir de apps/ai-agent
# Windows
cd apps/ai-agent && .venv\Scripts\python.exe -m pytest -q
# Linux/macOS
cd apps/ai-agent && .venv/bin/python -m pytest -q
```

Cobertura atual: buffer/debounce, ordem de chamada do processor, serviço de
histórico, classificador com contexto (agent); histórico ordenado/limitado/
normalizado e idempotência de `recordMessage` (API).

---

## Scripts disponíveis

| Comando              | Descrição                                    |
| -------------------- | -------------------------------------------- |
| `pnpm db:up`         | Inicia o PostgreSQL via Docker               |
| `pnpm db:down`       | Para o container do banco                    |
| `pnpm api:dev`       | Inicia a API em modo desenvolvimento         |
| `pnpm web:dev`       | Inicia o frontend em modo desenvolvimento    |
| `pnpm agent:dev`     | Inicia o agente de IA em modo desenvolvimento|
| `pnpm dev`           | Sobe banco + API + Web + agente em paralelo  |
| `pnpm lint`          | Lint em todos os workspaces                  |
| `pnpm format`        | Formata todos os arquivos com Prettier       |
| `pnpm format:check`  | Verifica a formatação sem alterar arquivos   |
| `pnpm --filter @financial-vellun/api test` | Testes unitários da API (Jest) |

> **Banco/Prisma:** aplicar migrations com `pnpm --filter @financial-vellun/api exec prisma migrate deploy`; resetar em dev com `... prisma migrate reset`; gerar o client com `... prisma generate`.

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
requisição precisa do header `x-webhook-signature` (HMAC-SHA256 do corpo). Em
desenvolvimento, sem o secret configurado, o webhook aceita sem assinatura.

---

## Fases de implementação

| Fase | Status | Escopo |
| ---- | ------ | ------ |
| **1 — Fundação** | ✅ Completo | Monorepo, schema Prisma, bootstrap apps, Docker |
| **2 — Produto Pessoal** | ✅ Completo | Auth JWT, perfis, CRUD de contas/categorias/lançamentos, dashboard |
| **3 — IA e WhatsApp** | 🚧 Em andamento | Webhook, extração de intenção, integração LLM; ingestão assíncrona com buffer/debounce, contexto conversacional, idempotência e backend Redis (ver [arquitetura](#arquitetura-de-processamento-de-mensagens-whatsapp--ia)) |
| **4 — Pessoa Jurídica** | 🚧 Em andamento | Dashboard empresarial, contas a pagar/receber, clientes/fornecedores, categorias |
| **5 — Evolução (pós-MVP)** | 🔜 Pendente | Recorrência, metas, relatórios, importação de extratos |

---

## Documentação

- [Requisitos técnicos](docs/technical-requirements.md)
- [Prompts de implementação](docs/implementation-prompts.md)
- [Requisitos — processamento assíncrono WhatsApp/IA](docs/whatsapp-ai-async-processing-requirements.md)
- [Plano — processamento assíncrono WhatsApp/IA](plan/whatsapp-ai-async-processing-plan.md)
- [Swagger da API](http://localhost:3001/api/docs) *(com o servidor rodando)*
