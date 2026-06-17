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

| Variável                  | Descrição                                        |
| ------------------------- | ------------------------------------------------ |
| `AI_AGENT_PORT`           | Porta do agente (padrão: `8000`)                 |
| `MAIN_API_URL`            | URL da API (padrão: `http://localhost:3001`)     |
| `INTERNAL_API_KEY`        | Mesma chave configurada na API                   |
| `OPENAI_API_KEY`          | Chave da OpenAI (necessária para a Fase 3)       |
| `WHATSAPP_PROVIDER_TOKEN` | Token do provedor WhatsApp (Fase 3)              |
| `WHATSAPP_WEBHOOK_SECRET` | Segredo para validar webhooks (Fase 3)           |

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

> Para resetar o banco em desenvolvimento: `pnpm --filter @financial-vellun/api exec prisma migrate reset`

### 5. Configurar o agente de IA (Python)

```bash
cd apps/ai-agent

# Criar ambiente virtual
python -m venv .venv

# Ativar (Windows)
.venv\Scripts\activate

# Ativar (macOS/Linux)
source .venv/bin/activate

# Instalar dependências
pip install -e .
```

---

## Rodando o projeto

Abra um terminal para cada serviço:

```bash
# Terminal 1 — API (porta 3001)
pnpm api:dev

# Terminal 2 — Web (porta 3000)
pnpm web:dev

# Terminal 3 — Agente de IA (porta 8000)
pnpm agent:dev
```

| Serviço    | URL                                      |
| ---------- | ---------------------------------------- |
| Web        | http://localhost:3000                    |
| API        | http://localhost:3001                    |
| Swagger    | http://localhost:3001/api/docs           |
| AI Agent   | http://localhost:8000                    |
| Health     | http://localhost:8000/health             |

---

## Scripts disponíveis

| Comando              | Descrição                                    |
| -------------------- | -------------------------------------------- |
| `pnpm db:up`         | Inicia o PostgreSQL via Docker               |
| `pnpm db:down`       | Para o container do banco                    |
| `pnpm api:dev`       | Inicia a API em modo desenvolvimento         |
| `pnpm web:dev`       | Inicia o frontend em modo desenvolvimento    |
| `pnpm agent:dev`     | Inicia o agente de IA em modo desenvolvimento|
| `pnpm lint`          | Lint em todos os workspaces                  |
| `pnpm format`        | Formata todos os arquivos com Prettier       |

---

## Fases de implementação

| Fase | Status | Escopo |
| ---- | ------ | ------ |
| **1 — Fundação** | ✅ Completo | Monorepo, schema Prisma, bootstrap apps, Docker |
| **2 — Produto Pessoal** | ✅ Completo | Auth JWT, perfis, CRUD de contas/categorias/lançamentos, dashboard |
| **3 — IA e WhatsApp** | 🔜 Pendente | Webhook, extração de intenção, integração LLM |
| **4 — Pessoa Jurídica** | 🔜 Pendente | Dashboard empresarial, contas a pagar/receber, clientes |
| **5 — Evolução (pós-MVP)** | 🔜 Pendente | Recorrência, metas, relatórios, importação de extratos |

---

## Documentação

- [Requisitos técnicos](docs/technical-requirements.md)
- [Prompts de implementação](docs/implementation-prompts.md)
- [Swagger da API](http://localhost:3001/api/docs) *(com o servidor rodando)*
