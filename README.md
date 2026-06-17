# Financial Vellun

Aplicação de controle financeiro para pessoa física e jurídica, com suporte a lançamentos via WhatsApp usando agente de IA.

## Estrutura do monorepo

```
financial-vellun/
  apps/
    web/        # Frontend Next.js
    api/        # API principal NestJS + Prisma
    ai-agent/   # Agente de IA Python + FastAPI
  packages/
    shared/     # Tipos, enums e schemas Zod compartilhados
    config/     # Configurações de TS, ESLint e Prettier
  infra/
    docker/     # Docker Compose com PostgreSQL
    database/   # Scripts de banco auxiliares
  docs/
    technical-requirements.md
    implementation-prompts.md
  plan/
    implementation-plan.md
```

## Requisitos

- Node.js >= 20
- pnpm >= 9
- Python >= 3.11
- Docker Desktop

## Iniciar o banco de dados

```bash
pnpm db:up
```

## Documentação

- [Requisitos técnicos](docs/technical-requirements.md)
- [Prompts de implementação](docs/implementation-prompts.md)
