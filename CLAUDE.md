# Financial Vellun — Project Guide

## Overview

Monorepo iniciado em 2026-06-17. Aplicação de controle financeiro para **pessoa física e jurídica**, com lançamentos via WhatsApp usando agente de IA. Construção incremental por fases (ver final deste documento).

## Stack

| Camada    | Tecnologia                                          |
| --------- | --------------------------------------------------- |
| Frontend  | Next.js 14 (App Router) + Tailwind CSS + shadcn/ui (`apps/web`) |
| Backend   | NestJS + Prisma + PostgreSQL (`apps/api`)           |
| AI Agent  | Python + FastAPI (`apps/ai-agent`)                  |
| Shared    | TypeScript + Zod (`packages/shared`)                |
| Config    | TS / ESLint / Prettier compartilhados (`packages/config`) |
| Monorepo  | pnpm workspaces                                     |
| Language  | TypeScript (strict) + Python 3.11                   |

## Estrutura do Monorepo

```
financial-vellun/
├── apps/
│   ├── web/            # @financial-vellun/web — Next.js 14 + Tailwind + shadcn/ui
│   ├── api/            # @financial-vellun/api — NestJS + Prisma + PostgreSQL
│   └── ai-agent/       # Agente de IA — Python + FastAPI (venv própria)
├── packages/
│   ├── shared/         # @financial-vellun/shared — tipos, enums e schemas Zod
│   └── config/         # @financial-vellun/config — tsconfig/eslint/prettier base
├── infra/
│   └── docker/         # docker-compose.yml (PostgreSQL)
├── docs/               # technical-requirements.md, implementation-prompts.md
├── package.json        # raiz: scripts dev/db/lint/format
├── pnpm-workspace.yaml
├── tsconfig.json       # raiz (references)
├── .prettierrc.js / .eslintrc.js
└── .gitignore
```

## Estrutura interna dos apps

```
apps/api/src/        accounts/ auth/ categories/ contacts/ dashboard/
                     internal/ transactions/ users/ prisma/ (cada módulo: *.module/*.controller/*.service + dto/)
apps/web/src/        app/ components/ contexts/ hooks/ lib/ middleware.ts
                     app/(auth)/{login,cadastro}  app/app/{pessoal,empresa,conta}
apps/ai-agent/src/   main.py config.py routers/ schemas/ services/
```

## Commands

```bash
pnpm install                       # instalar dependências Node
pnpm dev                           # db:up + api + web + agent em paralelo (concurrently)
pnpm db:up                         # subir PostgreSQL via Docker
pnpm db:down                       # parar o container do banco
pnpm api:dev                       # apenas API (porta 3001)
pnpm web:dev                       # apenas frontend (porta 3000)
pnpm agent:dev                     # apenas agente de IA (porta 8010, usa .venv\Scripts\python.exe)
pnpm lint                          # ESLint em todo o repo
pnpm format                        # aplicar Prettier
pnpm format:check                  # checar formatação

# Banco / Prisma (a partir da raiz)
pnpm --filter @financial-vellun/api exec prisma migrate deploy   # aplicar migrations
pnpm --filter @financial-vellun/api exec prisma migrate reset    # resetar (dev)
pnpm --filter @financial-vellun/api db:seed                      # categorias padrão + usuário demo
```

| Serviço  | URL                            |
| -------- | ------------------------------ |
| Web      | http://localhost:3000          |
| API      | http://localhost:3001          |
| Swagger  | http://localhost:3001/api/docs |
| AI Agent | http://localhost:8010          |
| Health   | http://localhost:8010/health   |

### Agente de IA (Python)

A venv é dedicada a `apps/ai-agent`. **Não recrie `.venv` por cima** se ela já existir — use a existente ou pare os processos Python/uvicorn antes de remover. `pnpm agent:dev` já chama `.venv\Scripts\python.exe` diretamente, então não é preciso ativar manualmente para rodar pelo monorepo.

```bash
cd apps/ai-agent
python -m venv .venv                          # apenas na primeira vez
.venv\Scripts\python.exe -m pip install -e .  # instalar deps na própria venv
```

## Conventions

- Package names: `@financial-vellun/<name>`
- TypeScript strict mode; `target` ES2022, `module`/`moduleResolution` NodeNext
- **Prettier (este projeto usa ponto e vírgula):** `semi: true`, aspas simples, `trailingComma: 'all'`, `printWidth: 100`, `tabWidth: 2`
- Tipos/enums/schemas compartilhados via `@financial-vellun/shared` (workspace:\*); schemas Zod ficam em `packages/shared/src/schemas`
- API (NestJS): um diretório por domínio com `*.module.ts`, `*.controller.ts`, `*.service.ts` e `dto/`; validação com **class-validator** nos DTOs; documentar com `@ApiProperty` (Swagger)
- Web (Next.js App Router): rotas em `app/`, componentes shadcn/ui em `components/ui`, cliente de API em `lib/api-client.ts`, auth em `contexts/auth-context.tsx` + `lib/auth.ts`
- AI Agent (FastAPI): rotas em `routers/`, contratos em `schemas/`, lógica em `services/`
- Variáveis sensíveis sempre em `.env` (nunca commitar); `INTERNAL_API_KEY` deve ser idêntica entre API e agente de IA

## Obrigatório

- Todo código de front-end deve ser desenvolvido com abordagem **mobile first**.
- Começar a implementação pelo layout e comportamento em telas pequenas, depois adicionar melhorias progressivas para tablets e desktops com breakpoints responsivos.
- Evitar criar componentes pensando primeiro em desktop e apenas "adaptar" para mobile depois.
- Garantir que textos, botões, formulários, tabelas, modais, menus e cards funcionem bem em telas estreitas antes de finalizar qualquer tela.
- Sempre que houver alteração visual relevante, considerar estados em mobile, tablet e desktop.
- Listas paginadas devem priorizar leitura confortável em mobile: usar **10 itens por página como padrão**.
- Evitar páginas com muitos itens, como 20 por página, salvo quando houver justificativa clara e a tela continuar confortável em mobile e desktop.
- Em abas com conteúdo denso, como Financeiro, preferir menos itens por página e boa hierarquia visual a listas longas que dificultem a leitura.

## Máscaras e Validações de Campos (obrigatório em todo o projeto)

Toda vez que um dos tipos de campo abaixo aparecer em qualquer tela (cadastro, edição, filtros, etc.), aplicar **obrigatoriamente** a máscara no frontend e a validação correspondente no frontend (Zod) e no backend (class-validator).

### Padrão de implementação de máscara

Usar funções puras de máscara (`maskXxx`) no nível do módulo do componente. Aplicar via `onChange` sobrescrito após o spread de `register`:

```tsx
{...register('campo')}
onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
  const masked = maskXxx(e.target.value)
  e.target.value = masked
  setValue('campo', masked, { shouldDirty: true })
}}
```

Em modo edição, converter o valor vindo da API para display antes de passar ao `defaultValues` do `useForm`.

### Telefone / WhatsApp

| Aspecto            | Regra                                                                         |
| ------------------ | ----------------------------------------------------------------------------- |
| Máscara            | `(XX) XXXX-XXXX` (fixo, 10 dígitos) · `(XX) XXXXX-XXXX` (celular, 11 dígitos) |
| Placeholder        | `(00) 00000-0000`                                                             |
| Regex Zod          | `/^\(\d{2}\) \d{4,5}-\d{4}$/`                                                 |
| Backend `@Matches` | `/^\(\d{2}\) \d{4,5}-\d{4}$/`                                                 |
| Armazenamento      | Valor mascarado (ex: `(41) 99999-9999`)                                       |

### CEP

| Aspecto            | Regra                             |
| ------------------ | --------------------------------- |
| Máscara            | `XXXXX-XXX`                       |
| Placeholder        | `00000-000`                       |
| Regex Zod          | `/^\d{5}-?\d{3}$/`                |
| Backend `@Matches` | `/^\d{5}-?\d{3}$/`                |
| Armazenamento      | Valor mascarado (ex: `80240-000`) |

### E-mail

| Aspecto                | Regra                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Validação Zod          | `z.string().email('E-mail inválido')`                                                                                                  |
| Backend                | `@IsEmail()`                                                                                                                           |
| Feedback em tempo real | Adicionar `onBlur: () => void trigger('campo')` no `register` para exibir o erro imediatamente ao sair do campo, sem aguardar o submit |
| Armazenamento          | String literal                                                                                                                         |

### Valores monetários (R$)

| Aspecto            | Regra                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Máscara            | Formato BR: `1.500,00` (ponto = milhar, vírgula = decimal, máx 2 casas)                                      |
| Placeholder        | `0,00`                                                                                                       |
| Label              | Incluir `(R$)` no label do campo                                                                             |
| `inputMode`        | `"decimal"` no input                                                                                         |
| Regex Zod          | `/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/`                                                                           |
| Backend            | `@IsDecimal({ decimal_digits: '0,2' })`                                                                      |
| Envio à API        | Converter em `toApiPayload`: `"1.500,00"` → `"1500.00"` (remover pontos, trocar vírgula por ponto)           |
| Recebimento da API | Converter para display com `toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })` |

### CPF / CNPJ

| Campo | Máscara              | Regex                                  |
| ----- | -------------------- | -------------------------------------- |
| CPF   | `XXX.XXX.XXX-XX`     | `/^\d{3}\.\d{3}\.\d{3}-\d{2}$/`        |
| CNPJ  | `XX.XXX.XXX/XXXX-XX` | `/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/` |

## Fases de implementação

| Fase | Status | Escopo |
| ---- | ------ | ------ |
| **1 — Fundação** | ✅ Completo | Monorepo, schema Prisma, bootstrap dos apps, Docker |
| **2 — Produto Pessoal** | ✅ Completo | Auth JWT, perfis, CRUD de contas/categorias/lançamentos, dashboard |
| **3 — IA e WhatsApp** | 🔜 Pendente | Webhook, extração de intenção, integração LLM |
| **4 — Pessoa Jurídica** | ✅ Em andamento | Dashboard empresarial, contas a pagar/receber, clientes/fornecedores, categorias |
| **5 — Evolução (pós-MVP)** | 🔜 Pendente | Recorrência, metas, relatórios, importação de extratos |

## Documentação

- [Fluxos do backend (diagramas Mermaid)](docs/backend-flows.md) — API + agente de IA, com o fluxo WhatsApp → lançamento detalhado
- [Requisitos técnicos](docs/technical-requirements.md)
- [Prompts de implementação](docs/implementation-prompts.md)
- [README](README.md) — setup detalhado, variáveis de ambiente e troubleshooting
- [Swagger da API](http://localhost:3001/api/docs) *(com o servidor rodando)*
