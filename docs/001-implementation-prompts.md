# Financial Vellun — Prompts Incrementais de Implementação

## Como usar este documento

Execute os prompts **em ordem numérica**, um de cada vez, em um agente de codificação (ex.: Claude Code). Antes de avançar para o próximo prompt, valide o **critério de aceite** do prompt atual. Cada prompt é autossuficiente: contém todo o contexto necessário para ser executado de forma isolada.

**Regras gerais:**

- Nunca pule prompts sem confirmar que os pré-requisitos estão satisfeitos.
- Cada prompt deve resultar em código funcional e comitável.
- Testes manuais simples são suficientes nos primeiros prompts; adicione testes automatizados conforme a base estabiliza.
- As decisões marcadas como `[ajustável]` podem ser trocadas antes de executar o prompt correspondente.

## Convenções globais (leia antes de executar qualquer prompt)

| Item                    | Decisão                                               | Ajustável?  |
| ----------------------- | ----------------------------------------------------- | ----------- |
| Gerenciador de pacotes  | pnpm workspaces                                       | [ajustável] |
| Autenticação            | JWT access + refresh via cookies HTTP-only            | [ajustável] |
| Provedor de WhatsApp    | Abstraído via adapter (sem acoplar Z-API/Twilio/Meta) | [ajustável] |
| Provedor de LLM         | OpenAI, atrás de interface `LlmProvider`              | [ajustável] |
| Banco de dados          | PostgreSQL via Prisma ORM                             | não         |
| Linguagem API principal | TypeScript / NestJS                                   | não         |
| Linguagem AI Agent      | Python / FastAPI                                      | não         |
| Frontend                | Next.js + Tailwind CSS + shadcn/ui                    | não         |

**Tipos e enums compartilhados** (referência para todos os prompts):

```
ProfileType:     individual | business
TransactionType: income | expense | transfer
TransactionStatus: confirmed | pending | cancelled
TransactionSource: manual | whatsapp | ai | import | recurring
AccountType: checking | savings | cash | credit_card | digital_wallet | investment | other
```

**Formato padrão de erro da API:**

```json
{ "statusCode": 400, "message": "...", "error": "Bad Request" }
```

**Padrão de validação:** Zod em `packages/shared`; class-validator/Zod em `apps/api`; Pydantic em `apps/ai-agent`.

---

## Tabela de rastreabilidade

| Prompt      | Requisito de origem           |
| ----------- | ----------------------------- |
| P1.1 – P1.8 | §3, §15 Fase 1                |
| P2.1 – P2.2 | §4, §5.2                      |
| P2.3        | §5.1                          |
| P2.4        | §5.2, §12.1                   |
| P2.5        | §7                            |
| P2.6        | §8                            |
| P2.7 – P2.9 | §6                            |
| P2.10       | §5.3                          |
| P3.1        | §10                           |
| P3.2 – P3.7 | §9, §11.2, §11.3              |
| P4.1 – P4.4 | §5.4, §15 Fase 4              |
| P5.1 – P5.6 | §15 Fase 5, §14 (fora do MVP) |

---

## Fase 1 — Fundação

---

### P1.1 — Inicializar o monorepo

**Objetivo:** Criar a estrutura base do monorepo com pnpm workspaces, garantindo que todos os apps possam ser adicionados de forma independente.

**Pré-requisitos:** Node.js ≥ 20, pnpm ≥ 9 instalados na máquina.

**Escopo / tarefas:**

- Inicializar `package.json` raiz com `"private": true` e `workspaces: ["apps/*", "packages/*"]`.
- Criar `pnpm-workspace.yaml` listando `apps/*` e `packages/*`.
- Criar a estrutura de diretórios:
  ```
  financial-vellun/
    apps/
      web/       (vazio por ora)
      api/       (vazio por ora)
      ai-agent/  (vazio por ora)
    packages/
      shared/    (vazio por ora)
      config/    (vazio por ora)
    infra/
      docker/
      database/
    docs/
  ```
- Criar `.gitignore` raiz cobrindo `node_modules`, `dist`, `.env*`, `.next`, `__pycache__`, `*.pyc`, `.venv`.
- Criar `.nvmrc` com a versão do Node em uso.
- Criar `README.md` mínimo com nome do projeto e estrutura de diretórios.

**Arquivos/áreas afetadas:**

- `package.json` (raiz)
- `pnpm-workspace.yaml`
- `.gitignore`
- `.nvmrc`
- `README.md`
- Diretórios `apps/`, `packages/`, `infra/`, `docs/`

**Critério de aceite:**

- `pnpm install` na raiz não retorna erros.
- Todos os diretórios listados existem.
- `git status` mostra apenas os arquivos criados intencionalmente.

**Requisito de origem:** §3, §15 Fase 1

**Fora de escopo:** Qualquer código de aplicação; configuração de CI/CD.

---

### P1.2 — Configurar lint, formatação e TypeScript base

**Objetivo:** Padronizar qualidade de código em todo o monorepo com ESLint, Prettier e TypeScript compartilhados via `packages/config`.

**Pré-requisitos:** P1.1 concluído.

**Escopo / tarefas:**

- Em `packages/config`, criar:
  - `package.json` com nome `@financial-vellun/config`.
  - `tsconfig.base.json` com `strict: true`, `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`.
  - `tsconfig.nextjs.json` estendendo o base, com ajustes para Next.js.
  - `.eslintrc.base.js` com regras TypeScript e import/order.
  - `.prettierrc.js` com `semi: true`, `singleQuote: true`, `trailingComma: "all"`, `printWidth: 100`.
- Na raiz do monorepo:
  - `tsconfig.json` referenciando os apps (para IDEs).
  - `.eslintrc.js` estendendo `@financial-vellun/config`.
  - `.prettierrc.js` re-exportando `@financial-vellun/config`.
  - Script `"lint"` e `"format"` no `package.json` raiz usando `pnpm -r`.
- Instalar devDependências necessárias: `typescript`, `eslint`, `prettier`, plugins TypeScript/ESLint.

**Arquivos/áreas afetadas:**

- `packages/config/`
- `tsconfig.json` (raiz)
- `.eslintrc.js` (raiz)
- `.prettierrc.js` (raiz)
- `package.json` (raiz, scripts)

**Critério de aceite:**

- `pnpm lint` na raiz executa sem erros em arquivos existentes.
- `pnpm format` formata arquivos sem quebrar nada.
- `packages/config` está listado como workspace e pode ser referenciado por `@financial-vellun/config`.

**Requisito de origem:** §3, §15 Fase 1

**Fora de escopo:** Configuração específica de lint para cada app (feita nos prompts de bootstrap de cada app).

---

### P1.3 — Pacote shared com tipos, enums e schemas Zod

**Objetivo:** Criar `packages/shared` como a fonte única de verdade para tipos TypeScript, enums e schemas de validação usados tanto pelo `apps/api` quanto pelo `apps/web`.

**Pré-requisitos:** P1.2 concluído.

**Escopo / tarefas:**

- Em `packages/shared`, criar `package.json` com nome `@financial-vellun/shared` e `exports` apontando para `src/index.ts`.
- Instalar `zod` como dependência.
- Criar e exportar:
  - `src/enums.ts`: todos os enums (`ProfileType`, `TransactionType`, `TransactionStatus`, `TransactionSource`, `AccountType`) como `const` + type.
  - `src/schemas/user.ts`: schemas Zod para criação/atualização de usuário.
  - `src/schemas/transaction.ts`: schema Zod de `Transaction` com todos os campos do §6.
  - `src/schemas/category.ts`: schema Zod de `Category`.
  - `src/schemas/account.ts`: schema Zod de `Account`.
  - `src/types/api.ts`: tipos de resposta paginada `PaginatedResponse<T>` e `ApiError`.
  - `src/index.ts`: re-exporta tudo.
- `tsconfig.json` estendendo `@financial-vellun/config/tsconfig.base.json`.

**Arquivos/áreas afetadas:**

- `packages/shared/`

**Critério de aceite:**

- `pnpm --filter @financial-vellun/shared build` compila sem erros.
- Os enums e schemas podem ser importados em um arquivo de teste TypeScript simples sem erros de tipo.

**Requisito de origem:** §4, §6, §7, §8, §11

**Fora de escopo:** Schemas específicos do agente de IA (criados em P3.3); lógica de negócio.

---

### P1.4 — Docker Compose com PostgreSQL

**Objetivo:** Provisionar o banco de dados PostgreSQL local via Docker Compose para que os apps possam se conectar durante o desenvolvimento.

**Pré-requisitos:** Docker Desktop instalado; P1.1 concluído.

**Escopo / tarefas:**

- Criar `infra/docker/docker-compose.yml` com serviço `postgres`:
  - Imagem: `postgres:16-alpine`.
  - Variáveis de ambiente via `.env` (usando `env_file`).
  - Volume nomeado para persistência de dados.
  - Porta `5432:5432` exposta.
  - Health check com `pg_isready`.
- Criar `infra/docker/.env.example` com `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`.
- Criar `infra/docker/.env` (ignorado pelo git) copiando do `.env.example` com valores de desenvolvimento.
- Adicionar script `"db:up"` e `"db:down"` no `package.json` raiz.
- Documentar no `README.md` como iniciar o banco.

**Arquivos/áreas afetadas:**

- `infra/docker/docker-compose.yml`
- `infra/docker/.env.example`
- `infra/docker/.env` (não comitado)
- `package.json` (raiz, scripts)

**Critério de aceite:**

- `pnpm db:up` inicia o container sem erros.
- `docker ps` mostra o container `postgres` em estado `healthy`.
- É possível conectar ao banco via `psql` ou DBeaver usando as credenciais do `.env`.

**Requisito de origem:** §11, §15 Fase 1

**Fora de escopo:** Configuração de banco para produção; Redis ou qualquer outro serviço.

---

### P1.5 — Bootstrap do `apps/api` (NestJS + Prisma + Swagger)

**Objetivo:** Criar a estrutura inicial do `apps/api` com NestJS, Prisma conectado ao PostgreSQL e documentação Swagger acessível.

**Pré-requisitos:** P1.2, P1.3, P1.4 concluídos; banco rodando.

**Escopo / tarefas:**

- Scaffoldar NestJS com `@nestjs/cli` dentro de `apps/api`.
- Instalar e configurar:
  - `@nestjs/config` para leitura de `.env`.
  - `prisma` e `@prisma/client`.
  - `@nestjs/swagger` e `swagger-ui-express`.
  - `zod` e `class-validator` / `class-transformer`.
  - `@financial-vellun/shared` (workspace dependency).
- Criar `apps/api/.env.example` com todas as variáveis do §13 (`DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `API_PORT`, `INTERNAL_API_KEY`).
- Criar `apps/api/.env` (não comitado) com valores de desenvolvimento.
- Configurar `prisma/schema.prisma` mínimo (datasource + generator).
- Configurar Swagger em `main.ts` acessível em `/api/docs`.
- Configurar `tsconfig.json` estendendo `@financial-vellun/config`.
- Adicionar script `"dev"` no `apps/api/package.json`.
- Adicionar script `"api:dev"` no `package.json` raiz.

**Arquivos/áreas afetadas:**

- `apps/api/` (estrutura completa NestJS)
- `apps/api/prisma/schema.prisma`
- `apps/api/.env.example`
- `package.json` (raiz, scripts)

**Critério de aceite:**

- `pnpm api:dev` inicia o servidor em `http://localhost:3001` (ou porta configurada).
- `GET /` retorna `{"status": "ok"}`.
- `GET /api/docs` abre o Swagger UI.
- Prisma conecta ao PostgreSQL sem erros de conexão no boot.

**Requisito de origem:** §3.2, §13, §15 Fase 1

**Fora de escopo:** Nenhuma rota de negócio; autenticação; migrations reais.

---

### P1.6 — Schema Prisma completo, migration inicial e seed

**Objetivo:** Definir todas as tabelas do banco de dados conforme §11, rodar a migration inicial e popular categorias padrão do §7.

**Pré-requisitos:** P1.5 concluído; banco rodando.

**Escopo / tarefas:**

- Definir no `prisma/schema.prisma` os models completos de acordo com §4, §6, §7, §8 e §11:
  - `User`, `IndividualProfile`, `BusinessProfile`
  - `Account`, `Category`, `Transaction`
  - `WhatsappContact`, `AiConversation`, `AiMessage`, `AiExtractedTransaction`
- Usar enums Prisma para `ProfileType`, `TransactionType`, `TransactionStatus`, `TransactionSource`, `AccountType`.
- Adicionar índices obrigatórios: `user_id`, `transaction_date`, `type`, `category_id`, `account_id` (§12.4).
- Criar `PrismaModule` e `PrismaService` em `apps/api/src/prisma/`.
- Rodar `prisma migrate dev --name init`.
- Criar `prisma/seed.ts` que insere categorias padrão para `individual` e `business` (listas do §7) com `is_default: true`.
- Adicionar script `"db:seed"` no `apps/api/package.json`.
- Registrar `PrismaModule` como global no `AppModule`.

**Arquivos/áreas afetadas:**

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/`
- `apps/api/prisma/seed.ts`
- `apps/api/src/prisma/prisma.module.ts`
- `apps/api/src/prisma/prisma.service.ts`

**Critério de aceite:**

- `prisma migrate status` mostra a migration `init` aplicada.
- `pnpm db:seed` insere as categorias padrão sem erros.
- Consulta SQL `SELECT count(*) FROM categories WHERE is_default = true` retorna o total esperado (20 categorias: 10 individual + 10 business).

**Requisito de origem:** §4, §6, §7, §8, §11, §12.4

**Fora de escopo:** Nenhuma lógica de negócio; endpoints; relações entre usuários e categorias (feito em P2.5).

---

### P1.7 — Bootstrap do `apps/web` (Next.js + Tailwind + shadcn/ui)

**Objetivo:** Criar o projeto Next.js com Tailwind CSS e shadcn/ui configurados, mais um cliente HTTP tipado para comunicar com `apps/api`.

**Pré-requisitos:** P1.2, P1.3 concluídos.

**Escopo / tarefas:**

- Scaffoldar Next.js 14+ com App Router, TypeScript e Tailwind em `apps/web`.
- Instalar e inicializar shadcn/ui.
- Instalar `react-hook-form` e `zod` (para validação client-side).
- Instalar `@financial-vellun/shared` (workspace dependency).
- Criar `apps/web/src/lib/api-client.ts`: wrapper tipado sobre `fetch` (ou `ky`) que aponta para `NEXT_PUBLIC_API_URL`.
- Criar `apps/web/.env.local.example` com `NEXT_PUBLIC_API_URL=http://localhost:3001`.
- Criar `apps/web/.env.local` (não comitado).
- Configurar `tsconfig.json` estendendo `@financial-vellun/config/tsconfig.nextjs.json`.
- Configurar alias de path `@/*` para `src/*`.
- Adicionar script `"web:dev"` no `package.json` raiz.
- Página raiz `/` exibindo apenas `<h1>Financial Vellun</h1>` como placeholder.

**Arquivos/áreas afetadas:**

- `apps/web/` (estrutura completa Next.js)
- `apps/web/src/lib/api-client.ts`
- `apps/web/.env.local.example`
- `package.json` (raiz, scripts)

**Critério de aceite:**

- `pnpm web:dev` inicia em `http://localhost:3000`.
- A página raiz renderiza sem erros.
- `api-client.ts` exporta uma função tipada e importa tipos de `@financial-vellun/shared`.
- shadcn/ui: `npx shadcn-ui@latest add button` funciona.

**Requisito de origem:** §3.1, §13, §15 Fase 1

**Fora de escopo:** Nenhuma tela real; layout; autenticação.

---

### P1.8 — Bootstrap do `apps/ai-agent` (FastAPI + Pydantic)

**Objetivo:** Criar o projeto Python com FastAPI e Pydantic, configurado para receber webhooks e comunicar-se com `apps/api`.

**Pré-requisitos:** Python ≥ 3.11 instalado; P1.5 concluído.

**Escopo / tarefas:**

- Criar `apps/ai-agent/` com:
  - `pyproject.toml` (gerenciado com `uv` ou `pip` + `requirements.txt`).
  - `.python-version` com versão do Python.
  - `.venv/` (ignorado pelo git).
- Instalar dependências: `fastapi`, `uvicorn[standard]`, `pydantic`, `pydantic-settings`, `httpx`, `python-dotenv`.
- Criar estrutura de módulos:
  ```
  apps/ai-agent/
    src/
      main.py
      config.py        (Pydantic Settings)
      routers/
        health.py
        webhook.py     (placeholder)
      services/
        api_client.py  (cliente HTTP para apps/api)
  ```
- `config.py`: carregar variáveis do §13 (`AI_AGENT_PORT`, `MAIN_API_URL`, `INTERNAL_API_KEY`, `OPENAI_API_KEY`, `WHATSAPP_PROVIDER_TOKEN`, `WHATSAPP_WEBHOOK_SECRET`).
- `api_client.py`: classe `ApiClient` com `httpx.AsyncClient`, injetando `INTERNAL_API_KEY` no header.
- `GET /health` retornando `{"status": "ok"}`.
- Criar `apps/ai-agent/.env.example` e `.env` (não comitado).
- Adicionar script `"agent:dev"` no `package.json` raiz chamando `uvicorn src.main:app --reload`.

**Arquivos/áreas afetadas:**

- `apps/ai-agent/` (estrutura completa)
- `apps/ai-agent/src/main.py`
- `apps/ai-agent/src/config.py`
- `apps/ai-agent/src/services/api_client.py`
- `apps/ai-agent/.env.example`

**Critério de aceite:**

- `pnpm agent:dev` inicia em `http://localhost:8000`.
- `GET /health` retorna `{"status": "ok"}`.
- `config.py` carrega variáveis sem erros quando `.env` está presente.

**Requisito de origem:** §3.3, §13, §15 Fase 1

**Fora de escopo:** Nenhuma lógica de IA; webhooks reais; integração com LLM.

---

## Fase 2 — Produto Pessoal

---

### P2.1 — Autenticação na API (register, login, logout, refresh, me)

**Objetivo:** Implementar o fluxo completo de autenticação com JWT via cookies HTTP-only, protegendo todas as rotas autenticadas com guard.

**Pré-requisitos:** P1.5, P1.6 concluídos.

**Escopo / tarefas:**

- Instalar `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt`, `bcrypt`, `cookie-parser`.
- Criar `AuthModule` com:
  - `AuthService`: `register(dto)`, `login(dto)`, `logout()`, `refresh(refreshToken)`, `me(userId)`.
  - `JwtStrategy` (access token lido do cookie `access_token`).
  - `JwtRefreshStrategy` (refresh token lido do cookie `refresh_token`).
  - `JwtAuthGuard` (global ou aplicado por decorator).
- Endpoints:
  - `POST /auth/register` — criar usuário (nome, email, senha), retornar user sem senha.
  - `POST /auth/login` — validar credenciais, setar cookies `access_token` (15 min) e `refresh_token` (7 dias) com flags `httpOnly`, `sameSite: strict`.
  - `POST /auth/logout` — limpar cookies.
  - `POST /auth/refresh` — renovar access token usando refresh token.
  - `GET /auth/me` — retornar usuário autenticado (requer guard).
- Senha armazenada com `bcrypt` (salt rounds ≥ 12).
- Validação dos DTOs com `class-validator`.
- Nunca retornar `password_hash` em nenhum endpoint.
- Configurar `cookie-parser` no `main.ts`.

**Arquivos/áreas afetadas:**

- `apps/api/src/auth/`
- `apps/api/src/auth/auth.module.ts`
- `apps/api/src/auth/auth.service.ts`
- `apps/api/src/auth/auth.controller.ts`
- `apps/api/src/auth/strategies/`
- `apps/api/src/auth/guards/`
- `apps/api/src/auth/dto/`

**Critério de aceite:**

- `POST /auth/register` cria usuário e retorna dados sem `password_hash`.
- `POST /auth/login` com credenciais válidas seta os dois cookies.
- `GET /auth/me` sem cookie retorna `401`.
- `GET /auth/me` com cookie válido retorna dados do usuário.
- `POST /auth/refresh` renova o access token.
- `POST /auth/logout` limpa os cookies.

**Requisito de origem:** §5.2, §12.1

**Fora de escopo:** OAuth/social login; e-mail de confirmação; reset de senha; 2FA.

---

### P2.2 — Perfis individual e business + redirecionamento

**Objetivo:** Criar endpoints para completar o perfil do usuário (`IndividualProfile` ou `BusinessProfile`) e retornar o `profile_type` no `GET /auth/me` para guiar o redirecionamento no frontend.

**Pré-requisitos:** P2.1 concluído.

**Escopo / tarefas:**

- Criar `UsersModule` com:
  - `GET /users/me/profile` — retorna o perfil completo (individual ou business).
  - `POST /users/me/profile/individual` — cria/atualiza `IndividualProfile` (CPF, data de nascimento).
  - `POST /users/me/profile/business` — cria/atualiza `BusinessProfile` (razão social, nome fantasia, CNPJ).
  - `PATCH /users/me` — atualizar nome do usuário.
- `GET /auth/me` deve incluir `profile_type` e `has_profile` (boolean).
- Validação de CPF (formato) e CNPJ (formato) nos DTOs.
- Isolamento por usuário: `user_id` sempre extraído do JWT, nunca do body.

**Arquivos/áreas afetadas:**

- `apps/api/src/users/`
- `apps/api/src/users/users.module.ts`
- `apps/api/src/users/users.service.ts`
- `apps/api/src/users/users.controller.ts`
- `apps/api/src/users/dto/`

**Critério de aceite:**

- `POST /auth/register` + `POST /users/me/profile/individual` cria perfil sem erros.
- `GET /auth/me` retorna `profile_type: "individual"` e `has_profile: true`.
- Um usuário não consegue acessar o perfil de outro (retorna `403` ou dados filtrados).

**Requisito de origem:** §4, §5.2

**Fora de escopo:** Upload de foto de perfil; validação de CPF/CNPJ com receita federal.

---

### P2.3 — Landing page pública

**Objetivo:** Implementar a página pública `/` apresentando o produto, com links para login e cadastro.

**Pré-requisitos:** P1.7 concluído.

**Escopo / tarefas:**

- Criar layout raiz em `apps/web/src/app/layout.tsx` com fontes e Tailwind.
- Criar `apps/web/src/app/page.tsx` (landing page) com:
  - Seção hero: nome do produto, tagline, CTAs "Entrar" e "Criar conta".
  - Seção de funcionalidades: controle pessoal, controle empresarial, lançamentos via WhatsApp (§5.1).
  - Footer mínimo.
- Usar componentes shadcn/ui (`Button`, `Card`).
- Página deve ser estática (sem chamadas de API).
- Responsiva (mobile-first).

**Arquivos/áreas afetadas:**

- `apps/web/src/app/page.tsx`
- `apps/web/src/app/layout.tsx`
- `apps/web/src/components/landing/`

**Critério de aceite:**

- `http://localhost:3000` renderiza a landing page.
- Os botões "Entrar" e "Criar conta" existem (podem ser links placeholder ainda).
- Página responsiva em viewport mobile (375px) e desktop (1280px).

**Requisito de origem:** §5.1

**Fora de escopo:** Animações; internacionalização; SEO avançado.

---

### P2.4 — Telas de login e cadastro + proteção de rotas

**Objetivo:** Implementar as telas de autenticação no frontend e proteger rotas autenticadas com middleware de sessão.

**Pré-requisitos:** P2.1, P2.3 concluídos.

**Escopo / tarefas:**

- Criar páginas:
  - `apps/web/src/app/(auth)/login/page.tsx` — formulário com email/senha, React Hook Form + Zod.
  - `apps/web/src/app/(auth)/cadastro/page.tsx` — formulário com nome, email, senha, confirmar senha, seleção de `profile_type`.
- Criar `apps/web/src/lib/auth.ts` com funções `login()`, `register()`, `logout()`, `getMe()` chamando `apps/api`.
- Criar contexto/hook `useAuth()` para guardar estado do usuário no cliente.
- Criar middleware Next.js em `apps/web/src/middleware.ts`:
  - Rotas `/app/*` requerem autenticação (redirecionar para `/login` se não autenticado).
  - Rota `/login` e `/cadastro` redirecionam para `/app/...` se já autenticado.
- Após login bem-sucedido, redirecionar conforme `profile_type`:
  - `individual` → `/app/pessoal/dashboard`
  - `business` → `/app/empresa/dashboard`
- Exibir mensagens de erro de validação inline nos formulários.
- Criar páginas placeholder vazias para `/app/pessoal/dashboard` e `/app/empresa/dashboard`.

**Arquivos/áreas afetadas:**

- `apps/web/src/app/(auth)/`
- `apps/web/src/app/app/`
- `apps/web/src/lib/auth.ts`
- `apps/web/src/middleware.ts`
- `apps/web/src/contexts/auth-context.tsx`

**Critério de aceite:**

- Cadastro com dados válidos cria conta e redireciona para a área correta.
- Login com credenciais inválidas exibe mensagem de erro.
- Acessar `/app/pessoal/dashboard` sem estar logado redireciona para `/login`.
- Acessar `/login` já logado redireciona para o dashboard correto.

**Requisito de origem:** §5.2, §12.1

**Fora de escopo:** OAuth; login social; "lembrar-me"; recuperação de senha.

---

### P2.5 — CRUD de Categorias (API + web)

**Objetivo:** Implementar gerenciamento completo de categorias financeiras, incluindo categorias padrão pré-criadas no seed e categorias personalizadas por usuário.

**Pré-requisitos:** P2.1, P2.4 concluídos.

**Escopo / tarefas:**

**API (`apps/api`):**

- Criar `CategoriesModule` com endpoints:
  - `GET /categories` — listar categorias do usuário + categorias padrão (`is_default: true`) filtradas por `profile_type`.
  - `POST /categories` — criar categoria personalizada.
  - `PATCH /categories/:id` — editar categoria do usuário (não pode editar categorias padrão alheias).
  - `DELETE /categories/:id` — excluir (apenas próprias; rejeitar se houver lançamentos vinculados).
- Todos os endpoints protegidos por `JwtAuthGuard`.
- `user_id` extraído do JWT; categorias de outros usuários retornam `403`.

**Web (`apps/web`):**

- Criar página `/app/pessoal/categorias` com:
  - Tabela de categorias (nome, tipo, cor, ícone, padrão/personalizada).
  - Botão "Nova categoria".
  - Modal/formulário de criação e edição (shadcn/ui `Dialog`).
  - Confirmação antes de excluir.
- Criar componentes reutilizáveis: `CategoryForm`, `CategoryTable`.

**Arquivos/áreas afetadas:**

- `apps/api/src/categories/`
- `apps/web/src/app/app/pessoal/categorias/`
- `apps/web/src/components/categories/`

**Critério de aceite:**

- `GET /categories` retorna as categorias padrão do seed + categorias do usuário logado.
- Criar, editar e excluir categoria funcionam ponta a ponta.
- Tentar excluir categoria com lançamentos vinculados retorna erro descritivo.
- Usuário A não vê categorias personalizadas do usuário B.

**Requisito de origem:** §7

**Fora de escopo:** Subcategorias; ícones customizados via upload; categorias compartilhadas entre usuários.

---

### P2.6 — CRUD de Contas Financeiras (API + web)

**Objetivo:** Implementar gerenciamento de contas financeiras (corrente, poupança, carteira digital etc.) com saldo calculado a partir do saldo inicial e lançamentos.

**Pré-requisitos:** P2.1, P2.4 concluídos.

**Escopo / tarefas:**

**API (`apps/api`):**

- Criar `AccountsModule` com endpoints:
  - `GET /accounts` — listar contas ativas do usuário.
  - `GET /accounts/:id` — detalhes de uma conta.
  - `POST /accounts` — criar conta (nome, tipo, saldo inicial, moeda).
  - `PATCH /accounts/:id` — editar conta.
  - `DELETE /accounts/:id` — desativar conta (`is_active: false`); rejeitar se houver lançamentos vinculados.
- `current_balance` deve ser calculado como `initial_balance + soma de income - soma de expense` dos lançamentos `confirmed` da conta.
- Isolamento por `user_id`.

**Web (`apps/web`):**

- Criar página `/app/pessoal/contas` com:
  - Cards de contas exibindo nome, tipo, saldo atual.
  - Botão "Nova conta".
  - Modal de criação/edição.
  - Ação de desativar conta.

**Arquivos/áreas afetadas:**

- `apps/api/src/accounts/`
- `apps/web/src/app/app/pessoal/contas/`
- `apps/web/src/components/accounts/`

**Critério de aceite:**

- `GET /accounts` lista apenas as contas do usuário autenticado.
- Criar conta com `initial_balance: 1000` e nenhum lançamento retorna `current_balance: 1000`.
- Editar e desativar conta funcionam sem erros.

**Requisito de origem:** §8

**Fora de escopo:** Reconciliação bancária; importação de extrato; múltiplas moedas (frontend).

---

### P2.7 — CRUD de Lançamentos (API)

**Objetivo:** Implementar todos os endpoints de lançamentos financeiros com validação completa, filtros, ordenação e paginação.

**Pré-requisitos:** P2.5, P2.6 concluídos.

**Escopo / tarefas:**

- Criar `TransactionsModule` com endpoints:
  - `GET /transactions` — listar com filtros obrigatórios (§6): `period` (start/end date), `type`, `category_id`, `account_id`, `status`, `source`, `search` (texto na description). Paginação: `page`, `limit`. Ordenação: `sort_by`, `order`.
  - `GET /transactions/:id` — detalhes.
  - `POST /transactions` — criar lançamento manual (`source: "manual"`).
  - `PATCH /transactions/:id` — editar.
  - `DELETE /transactions/:id` — cancelar (`status: "cancelled"`) ou excluir definitivamente (com flag `hard_delete`).
- Validações:
  - `amount` deve ser positivo.
  - `account_id` e `category_id` devem pertencer ao usuário autenticado.
  - `transaction_date` não pode ser nula.
- Ao criar/editar lançamento `confirmed`, recalcular `current_balance` da conta associada.
- Isolamento rigoroso por `user_id` — nunca expor lançamentos de outro usuário.
- Resposta paginada no formato `PaginatedResponse<Transaction>` de `@financial-vellun/shared`.

**Arquivos/áreas afetadas:**

- `apps/api/src/transactions/`
- `apps/api/src/transactions/transactions.module.ts`
- `apps/api/src/transactions/transactions.service.ts`
- `apps/api/src/transactions/transactions.controller.ts`
- `apps/api/src/transactions/dto/`

**Critério de aceite:**

- `GET /transactions?type=expense&page=1&limit=10` retorna resposta paginada.
- `GET /transactions?search=mercado` filtra por texto na description.
- Criar lançamento `expense` de R$50 numa conta com saldo R$1000 atualiza o saldo para R$950.
- `GET /transactions/:id` de outro usuário retorna `403`.

**Requisito de origem:** §6, §12.4

**Fora de escopo:** Lançamentos recorrentes; transferências entre contas (lógica complexa); anexos.

---

### P2.8 — Tela de lançamentos com tabela, filtros e paginação

**Objetivo:** Implementar a tela de listagem de lançamentos no frontend com todos os filtros obrigatórios, ordenação e paginação.

**Pré-requisitos:** P2.7 concluído.

**Escopo / tarefas:**

- Criar página `/app/pessoal/lancamentos` com:
  - Tabela de lançamentos (shadcn/ui `Table`) exibindo: data, descrição, categoria, conta, tipo, valor, status, origem.
  - Painel de filtros: seletor de período (data início/fim), tipo, categoria, conta, status, origem, campo de busca por texto.
  - Paginação com controles anterior/próxima e seletor de itens por página.
  - Ordenação por coluna clicável.
  - Indicador de carregamento (`Skeleton` ou `Spinner`).
  - Estado vazio ("Nenhum lançamento encontrado").
- Os filtros devem sincronizar com a URL (query params) para permitir compartilhar/bookmarkar.
- Cores distintas para `income` (verde) e `expense` (vermelho).
- Badge de `source` para identificar lançamentos criados por IA.

**Arquivos/áreas afetadas:**

- `apps/web/src/app/app/pessoal/lancamentos/page.tsx`
- `apps/web/src/components/transactions/TransactionTable.tsx`
- `apps/web/src/components/transactions/TransactionFilters.tsx`
- `apps/web/src/hooks/useTransactions.ts`

**Critério de aceite:**

- Tabela renderiza lançamentos paginados da API.
- Filtro por tipo (`income`/`expense`) recarrega a tabela corretamente.
- Busca por texto filtra por descrição.
- Navegação entre páginas funciona.
- URL atualiza ao mudar filtros.

**Requisito de origem:** §6

**Fora de escopo:** Exportação CSV; gráficos na tela de listagem.

---

### P2.9 — Criação e edição manual de lançamentos (web)

**Objetivo:** Implementar o formulário de criação e edição de lançamentos, acessível a partir da tela de listagem.

**Pré-requisitos:** P2.8 concluído.

**Escopo / tarefas:**

- Criar componente `TransactionForm` (modal ou página lateral) com campos:
  - Tipo (`income` / `expense` / `transfer`) — altera dinamicamente campos disponíveis.
  - Valor (número, formato moeda).
  - Descrição (texto).
  - Categoria (select buscando `GET /categories`).
  - Conta (select buscando `GET /accounts`).
  - Data do lançamento (date picker).
  - Status (`confirmed` / `pending`).
- Validação client-side com React Hook Form + Zod.
- Botão "Salvar" — chama `POST /transactions` ou `PATCH /transactions/:id`.
- Botão "Cancelar lançamento" no formulário de edição (chama DELETE com soft cancel).
- Após sucesso, recarregar a lista de lançamentos.
- Feedback visual de loading e erros da API.

**Arquivos/áreas afetadas:**

- `apps/web/src/components/transactions/TransactionForm.tsx`
- `apps/web/src/app/app/pessoal/lancamentos/page.tsx` (botão "Novo lançamento")

**Critério de aceite:**

- Criar lançamento de despesa de R$100 aparece na tabela imediatamente.
- Editar a descrição de um lançamento salva corretamente.
- Tentar salvar sem valor exibe erro de validação sem chamar a API.
- Cancelar um lançamento muda seu status para `cancelled` e reflete na tabela.

**Requisito de origem:** §6, §14

**Fora de escopo:** Upload de comprovante; lançamento parcelado; recorrência.

---

### P2.10 — Dashboard pessoa física (indicadores + gráficos)

**Objetivo:** Implementar o endpoint de indicadores e a tela de dashboard para usuários `individual`, exibindo saldo, receitas, despesas e distribuição por categoria.

**Pré-requisitos:** P2.7, P2.9 concluídos.

**Escopo / tarefas:**

**API (`apps/api`):**

- Criar `DashboardModule` com endpoint:
  - `GET /dashboard/summary?period_start=&period_end=` — retorna:
    - `total_balance`: soma de saldos de todas as contas ativas.
    - `total_income`: soma de receitas `confirmed` no período.
    - `total_expense`: soma de despesas `confirmed` no período.
    - `net_result`: `total_income - total_expense`.
    - `expenses_by_category`: array `{ category_name, total, percentage }`.
    - `recent_transactions`: últimos 5 lançamentos.
    - `monthly_comparison`: receitas e despesas dos últimos 3 meses (para gráfico).

**Web (`apps/web`):**

- Criar página `/app/pessoal/dashboard` com:
  - Cards: saldo atual, total de receitas, total de despesas, resultado do mês.
  - Gráfico de pizza/donut: distribuição por categoria (usar `recharts` ou `chart.js`).
  - Gráfico de barras: comparativo mensal.
  - Tabela dos últimos lançamentos (link para a tela completa).
  - Seletor de período (mês atual como default).

**Arquivos/áreas afetadas:**

- `apps/api/src/dashboard/`
- `apps/web/src/app/app/pessoal/dashboard/page.tsx`
- `apps/web/src/components/dashboard/`

**Critério de aceite:**

- `GET /dashboard/summary` com lançamentos existentes retorna valores corretos.
- Dashboard renderiza os cards com valores reais da API.
- Mudar o período recalcula todos os indicadores.
- Gráfico de categorias exibe distribuição proporcional.

**Requisito de origem:** §5.3

**Fora de escopo:** Dashboard pessoa jurídica (P4.1); metas; orçamentos; alertas.

---

## Fase 3 — IA e WhatsApp

---

### P3.1 — Endpoints internos protegidos por chave de serviço

**Objetivo:** Criar os endpoints internos em `apps/api` que serão consumidos exclusivamente pelo `apps/ai-agent`, protegidos por `INTERNAL_API_KEY`.

**Pré-requisitos:** P2.7 concluído.

**Escopo / tarefas:**

- Criar `InternalModule` com controller prefixado em `/internal`.
- Criar guard `InternalApiKeyGuard` que valida o header `x-internal-api-key` contra `INTERNAL_API_KEY` do `.env`.
- Implementar endpoints:
  - `GET /internal/whatsapp/contacts/:phone` — buscar usuário pelo número de telefone; retornar `user_id`, `name`, status de verificação.
  - `POST /internal/transactions/from-ai` — criar lançamento com `source: "ai"` ou `"whatsapp"`; aceita os campos de `Transaction` + `raw_input` + `ai_extracted_transaction_id`.
  - `POST /internal/ai-events` — registrar evento de auditoria (recebe payload livre, persistido em `AiExtractedTransaction`).
- Esses endpoints **não usam** `JwtAuthGuard`, apenas `InternalApiKeyGuard`.
- Nunca expor esses endpoints no Swagger público (usar tag separada ou desabilitar).

**Arquivos/áreas afetadas:**

- `apps/api/src/internal/`
- `apps/api/src/internal/internal.module.ts`
- `apps/api/src/internal/guards/internal-api-key.guard.ts`
- `apps/api/src/internal/controllers/`

**Critério de aceite:**

- `GET /internal/whatsapp/contacts/:phone` sem header retorna `401`.
- `GET /internal/whatsapp/contacts/:phone` com `x-internal-api-key` correto retorna dados do usuário (ou `404` se não encontrado).
- `POST /internal/transactions/from-ai` cria lançamento com `source: "ai"`.
- `POST /internal/ai-events` persiste o evento sem erros.

**Requisito de origem:** §10, §12.1

**Fora de escopo:** Rate limit nos endpoints internos (feito em P3 avançado); autenticação mTLS.

---

### P3.2 — Webhook simulado no `ai-agent` + identificação de contato

**Objetivo:** Criar o endpoint de webhook no `apps/ai-agent` que recebe mensagens (simuladas), valida a origem e identifica o usuário pelo número de telefone.

**Pré-requisitos:** P1.8, P3.1 concluídos.

**Escopo / tarefas:**

- Criar `apps/ai-agent/src/routers/webhook.py` com:
  - `POST /webhook/whatsapp` — recebe payload de mensagem (simulado no MVP, formato a definir).
  - Validação de assinatura HMAC do `WHATSAPP_WEBHOOK_SECRET` (mesmo que com payload simulado).
  - Extrair número de telefone e texto da mensagem.
  - Chamar `GET /internal/whatsapp/contacts/:phone` no `ApiClient`.
  - Se contato não encontrado, responder ao usuário: "Seu número não está vinculado a uma conta. Acesse o app para vincular."
  - Retornar `200` imediatamente (processamento async para não bloquear o provider).
- Criar schema Pydantic `WhatsappWebhookPayload` com campos: `phone`, `message`, `timestamp`, `message_id`.
- Criar `apps/ai-agent/src/services/contact_service.py` encapsulando a chamada ao `ApiClient`.

**Arquivos/áreas afetadas:**

- `apps/ai-agent/src/routers/webhook.py`
- `apps/ai-agent/src/schemas/webhook.py`
- `apps/ai-agent/src/services/contact_service.py`

**Critério de aceite:**

- `POST /webhook/whatsapp` com payload `{"phone": "+5511999999999", "message": "gastei 100 no mercado", "timestamp": ..., "message_id": ...}` retorna `200`.
- Com número não cadastrado, o serviço tenta notificar o usuário (log da tentativa).
- Com número cadastrado, o `user_id` é recuperado corretamente da API.

**Requisito de origem:** §9.1, §9.4

**Fora de escopo:** Integração com provedor real de WhatsApp; resposta via WhatsApp (apenas log no MVP do prompt).

---

### P3.3 — Schema `FinancialIntent` e interpretador de mensagens

**Objetivo:** Definir o schema estruturado de extração financeira e criar o pipeline de interpretação de mensagens em linguagem natural.

**Pré-requisitos:** P3.2 concluído.

**Escopo / tarefas:**

- Criar `apps/ai-agent/src/schemas/financial_intent.py` com modelo Pydantic `FinancialIntent` contendo todos os campos do §9.3:
  - `intent`, `transaction_type`, `amount`, `description`, `category_name`, `account_name`, `transaction_date`, `confidence` (float 0.0–1.0), `needs_confirmation`, `confirmation_question`.
- Criar `apps/ai-agent/src/services/intent_classifier.py`:
  - Método `classify(message: str, user_context: dict) -> FinancialIntent`.
  - Implementação inicial com regras simples (regex) como fallback para quando LLM não está configurado.
  - Deve identificar as intenções do §9.2: criar despesa/receita, consultar resumo, corrigir/cancelar último lançamento, pedir ajuda, responder confirmação.
- Criar testes unitários para o classificador com exemplos do §9 (ex.: "gastei 100 no mercado" → `expense`, `amount: 100`, `category: Mercado`).

**Arquivos/áreas afetadas:**

- `apps/ai-agent/src/schemas/financial_intent.py`
- `apps/ai-agent/src/services/intent_classifier.py`
- `apps/ai-agent/tests/test_intent_classifier.py`

**Critério de aceite:**

- `classify("gastei 100 no mercado", {})` retorna `FinancialIntent(transaction_type="expense", amount=100, category_name="Mercado", confidence≥0.8)`.
- `classify("recebi 5000 de salário", {})` retorna `transaction_type="income"`.
- `classify("paguei 300", {})` retorna `needs_confirmation=True` (sem categoria clara).
- Testes unitários passam com `pytest`.

**Requisito de origem:** §9.2, §9.3

**Fora de escopo:** LLM real (próximo prompt); contexto de conversa multi-turno completo.

---

### P3.4 — Camada LLM com OpenAI para extração estruturada

**Objetivo:** Substituir as regras simples por um LLM (OpenAI) para extração estruturada, mantendo o mesmo schema `FinancialIntent` e permitindo troca futura de provedor.

**Pré-requisitos:** P3.3 concluído; `OPENAI_API_KEY` configurada.

**Escopo / tarefas:**

- Criar interface (ABC) `LlmProvider` em `apps/ai-agent/src/services/llm/base.py` com método `extract_intent(message: str, context: dict) -> FinancialIntent`.
- Criar `OpenAiProvider` em `apps/ai-agent/src/services/llm/openai_provider.py`:
  - Usar `openai` SDK com `structured outputs` (function calling / response_format com JSON Schema).
  - System prompt descrevendo o schema e as categorias disponíveis do usuário.
  - Passar data atual para referência de datas relativas ("hoje", "ontem").
  - `model`: `gpt-4o-mini` como default [ajustável].
- Instalar `openai` SDK como dependência.
- Integrar `OpenAiProvider` no `IntentClassifier` como estratégia principal, com fallback para regras se LLM falhar.
- Criar `apps/ai-agent/src/services/llm/factory.py` que instancia o provider correto com base em variável de ambiente `LLM_PROVIDER`.

**Arquivos/áreas afetadas:**

- `apps/ai-agent/src/services/llm/`
- `apps/ai-agent/src/services/intent_classifier.py` (atualizado)
- `apps/ai-agent/src/config.py` (adicionar `LLM_PROVIDER`, `OPENAI_MODEL`)

**Critério de aceite:**

- Com `OPENAI_API_KEY` válida, `classify("gastei 47,50 no almoço ontem", {})` retorna resultado estruturado com data correta (ontem).
- Se `OPENAI_API_KEY` estiver ausente ou inválida, o fallback de regras é acionado sem quebrar o fluxo.
- Trocar `LLM_PROVIDER=rules` usa apenas regras; `LLM_PROVIDER=openai` usa o LLM.

**Requisito de origem:** §3.3, §9.3, §13

**Fora de escopo:** Fine-tuning; embeddings; memória semântica de longo prazo.

---

### P3.5 — Regras de confirmação e fluxo de diálogo

**Objetivo:** Implementar as regras de confirmação do §9.4, mantendo contexto de conversa para processar respostas do usuário a perguntas de confirmação.

**Pré-requisitos:** P3.4 concluído.

**Escopo / tarefas:**

- Criar `apps/ai-agent/src/services/conversation_manager.py`:
  - Armazenar estado de conversa em memória (dict por `phone`) com TTL de 30 minutos.
  - Estado: `pending_intent: FinancialIntent | None`, `awaiting_confirmation: bool`, `last_message_at`.
- Criar `apps/ai-agent/src/services/confirmation_rules.py`:
  - Função `needs_confirmation(intent: FinancialIntent) -> tuple[bool, str]` implementando todas as regras do §9.4:
    - Sem valor identificado.
    - Sem tipo (receita/despesa).
    - Mais de uma categoria provável.
    - Mensagem indica parcelamento.
    - Data ambígua.
    - Valor incoerente (ex.: > R$100.000 sem contexto).
    - Confiança abaixo de 0.7 (limiar configurável).
- Integrar no fluxo principal do webhook:
  - Se `needs_confirmation`, salvar intent pendente e retornar pergunta ao usuário.
  - Se usuário está em modo `awaiting_confirmation`, interpretar resposta como complemento do intent anterior.
  - Após confirmação, prosseguir para criação do lançamento.

**Arquivos/áreas afetadas:**

- `apps/ai-agent/src/services/conversation_manager.py`
- `apps/ai-agent/src/services/confirmation_rules.py`
- `apps/ai-agent/src/routers/webhook.py` (integração)

**Critério de aceite:**

- Enviar "paguei 300" → receber pergunta de confirmação de categoria.
- Responder "aluguel" → o lançamento é criado com categoria Aluguel.
- Enviar "gastei 100 no mercado" → lançamento criado diretamente sem confirmação.
- Enviar mensagem com `confidence < 0.7` → pergunta de confirmação.

**Requisito de origem:** §9.4

**Fora de escopo:** Persistência de contexto em banco (estado em memória é suficiente para MVP); contexto cross-session.

---

### P3.6 — Criação de lançamento via API interna com rastreabilidade

**Objetivo:** Completar o fluxo end-to-end: após intent confirmado, criar o lançamento em `apps/api` via endpoint interno, com `source` e `raw_input` rastreáveis.

**Pré-requisitos:** P3.5, P3.1 concluídos.

**Escopo / tarefas:**

- Criar `apps/ai-agent/src/services/transaction_creator.py`:
  - Método `create_from_intent(intent: FinancialIntent, user_id: str, raw_message: str) -> dict`.
  - Resolver `category_name` para `category_id` consultando a API (ou cache curto).
  - Resolver `account_name` para `account_id` (usar conta padrão do usuário se não informada).
  - Chamar `POST /internal/transactions/from-ai` com todos os campos mapeados.
  - Tratar erros da API e retornar resposta amigável ao usuário.
- Integrar no fluxo do webhook após confirmação.
- Formatar resposta de sucesso para o usuário: "Lançamento criado! Despesa de R$100,00 em Mercado em 17/06/2026."

**Arquivos/áreas afetadas:**

- `apps/ai-agent/src/services/transaction_creator.py`
- `apps/ai-agent/src/routers/webhook.py` (integração final)

**Critério de aceite:**

- Enviar "gastei 100 no mercado" via `POST /webhook/whatsapp` resulta em lançamento criado em `apps/api` com `source: "ai"`, `raw_input: "gastei 100 no mercado"`.
- Lançamento aparece na tela de lançamentos do web com badge de origem "IA".
- Falha na API retorna mensagem amigável ao usuário em vez de stacktrace.

**Requisito de origem:** §9.1, §14, §17

**Fora de escopo:** Envio real de resposta via WhatsApp (apenas log no MVP); desfazer lançamento via WhatsApp.

---

### P3.7 — Auditoria: conversas, mensagens e extrações de IA

**Objetivo:** Persistir toda a rastreabilidade das operações do agente de IA conforme §9.5, usando as tabelas `ai_conversations`, `ai_messages` e `ai_extracted_transactions`.

**Pré-requisitos:** P3.6 concluído.

**Escopo / tarefas:**

- Criar `apps/ai-agent/src/services/audit_service.py`:
  - `log_message(conversation_id, direction, content, metadata)` — chamar `POST /internal/ai-events`.
  - `log_extraction(user_id, raw_input, extracted_payload, confidence, status, transaction_id?)`.
- Atualizar o fluxo do webhook para registrar:
  - Mensagem recebida (`direction: "inbound"`).
  - Intent extraído + confiança + status (`confirmed` ou `pending_confirmation`).
  - Mensagem enviada ao usuário (`direction: "outbound"`).
  - Lançamento criado (se houver).
- Em `apps/api`, garantir que `POST /internal/ai-events` persiste em `AiExtractedTransaction` com todos os campos do §11.3.
- Criar endpoint (protegido por JWT) `GET /transactions/:id/ai-audit` que retorna a extração de IA associada ao lançamento.

**Arquivos/áreas afetadas:**

- `apps/ai-agent/src/services/audit_service.py`
- `apps/api/src/internal/` (atualizar `POST /internal/ai-events`)
- `apps/api/src/transactions/` (endpoint de auditoria)

**Critério de aceite:**

- Após processar "gastei 100 no mercado", existe registro em `ai_extracted_transactions` com `raw_input`, `extracted_payload`, `confidence` e `transaction_id`.
- `GET /transactions/:id/ai-audit` retorna a extração associada.
- Mensagem ambígua que gerou confirmação também fica registrada com `status: "pending"`.

**Requisito de origem:** §9.5, §11.2, §11.3, §12.2

**Fora de escopo:** Dashboard de auditoria de IA (interface web); reprocessamento de mensagens falhas.

---

## Fase 4 — Pessoa Jurídica

---

### P4.1 — Dashboard empresarial e fluxo de caixa

**Objetivo:** Implementar o dashboard para usuários `business` com foco em fluxo de caixa, receitas e despesas por período.

**Pré-requisitos:** P2.10 concluído; usuário do tipo `business` criado.

**Escopo / tarefas:**

**API (`apps/api`):**

- Estender `DashboardModule` com endpoint `GET /dashboard/business/summary` retornando:
  - Saldo total de contas ativas.
  - Total de receitas e despesas no período.
  - Fluxo de caixa diário no período (array `{ date, income, expense, balance }`).
  - Top 5 categorias de despesa.
  - Contas a receber (lançamentos `income` com `status: "pending"`).
  - Contas a pagar (lançamentos `expense` com `status: "pending"`).

**Web (`apps/web`):**

- Criar página `/app/empresa/dashboard` com:
  - Cards de saldo, receitas, despesas, resultado.
  - Gráfico de linha/área do fluxo de caixa.
  - Widgets de contas a pagar e receber com totais e links para telas dedicadas.
  - Seletor de período.

**Arquivos/áreas afetadas:**

- `apps/api/src/dashboard/` (atualizado)
- `apps/web/src/app/app/empresa/dashboard/page.tsx`
- `apps/web/src/components/dashboard/business/`

**Critério de aceite:**

- `GET /dashboard/business/summary` retorna fluxo de caixa diário correto.
- Dashboard empresarial renderiza sem erros com dados reais.
- Usuário `individual` não acessa `/app/empresa/*` (middleware redireciona).

**Requisito de origem:** §5.4

**Fora de escopo:** Centro de custo detalhado; DRE; relatório gerencial.

---

### P4.2 — Contas a pagar e a receber

**Objetivo:** Implementar as telas e endpoints de contas a pagar (despesas pendentes) e contas a receber (receitas pendentes) para usuários `business`.

**Pré-requisitos:** P4.1 concluído.

**Escopo / tarefas:**

- Reutilizar `GET /transactions` com filtros `type=expense&status=pending` (contas a pagar) e `type=income&status=pending` (contas a receber).
- Criar páginas no web:
  - `/app/empresa/contas-a-pagar` — lista de despesas pendentes com ação "Marcar como pago".
  - `/app/empresa/contas-a-receber` — lista de receitas pendentes com ação "Marcar como recebido".
- Ação "Marcar como pago/recebido" chama `PATCH /transactions/:id` com `status: "confirmed"`.
- Filtros: por período, por categoria, por conta.
- Total pendente em destaque no topo de cada tela.

**Arquivos/áreas afetadas:**

- `apps/web/src/app/app/empresa/contas-a-pagar/`
- `apps/web/src/app/app/empresa/contas-a-receber/`

**Critério de aceite:**

- Lançamento `expense + pending` aparece em contas a pagar.
- "Marcar como pago" atualiza status para `confirmed` e remove da lista de pendentes.
- Total pendente no topo é a soma dos valores filtrados.

**Requisito de origem:** §5.4

**Fora de escopo:** Boleto; nota fiscal; integração bancária; parcelamento.

---

### P4.3 — Clientes e fornecedores

**Objetivo:** Criar o CRUD básico de clientes e fornecedores para usuários `business`, permitindo vincular lançamentos a eles futuramente.

**Pré-requisitos:** P4.1 concluído.

**Escopo / tarefas:**

**API (`apps/api`):**

- Criar `ContactsModule` com model `Contact`:
  - Campos: `id`, `user_id`, `name`, `type` (`client` | `supplier`), `document` (CNPJ/CPF), `email`, `phone`, `notes`, `is_active`, `created_at`, `updated_at`.
- Endpoints: `GET /contacts`, `POST /contacts`, `PATCH /contacts/:id`, `DELETE /contacts/:id`.
- Filtro por `type` (`client` / `supplier`) e busca por nome.

**Web (`apps/web`):**

- Criar páginas:
  - `/app/empresa/clientes` — lista de clientes com busca e ações CRUD.
  - `/app/empresa/fornecedores` — lista de fornecedores com busca e ações CRUD.
- Modal de criação/edição compartilhado (com campo `type` preenchido por contexto).

**Arquivos/áreas afetadas:**

- `apps/api/src/contacts/`
- `apps/api/prisma/schema.prisma` (novo model `Contact` + migration)
- `apps/web/src/app/app/empresa/clientes/`
- `apps/web/src/app/app/empresa/fornecedores/`

**Critério de aceite:**

- Criar cliente com nome e CNPJ aparece na lista.
- Busca por nome filtra em tempo real.
- Fornecedor não aparece na lista de clientes e vice-versa.

**Requisito de origem:** §5.4

**Fora de escopo:** Histórico de transações por cliente/fornecedor (vínculo com `Transaction`); CRM; NFS-e.

---

### P4.4 — Categorias empresariais e centro de custo

**Objetivo:** Garantir que usuários `business` tenham as categorias padrão empresariais do §7 disponíveis e implementar o campo de centro de custo nas categorias.

**Pré-requisitos:** P2.5, P4.1 concluídos.

**Escopo / tarefas:**

- Adicionar campo `cost_center` (string, opcional) ao model `Category` no Prisma + migration.
- Confirmar que o seed do P1.6 inclui as 10 categorias padrão para `business` (Vendas, Serviços, Fornecedores, Impostos, Folha de pagamento, Aluguel, Marketing, Software, Transporte, Outros).
- Atualizar formulário de categoria no web para incluir campo "Centro de custo" (visível apenas para usuários `business`).
- Criar página `/app/empresa/categorias` reutilizando o componente de categorias do P2.5, com a coluna "Centro de custo" visível.
- Endpoint `GET /categories` deve filtrar por `profile_type` do usuário logado para não misturar categorias pessoais com empresariais.

**Arquivos/áreas afetadas:**

- `apps/api/prisma/schema.prisma` (campo `cost_center`)
- `apps/api/prisma/migrations/`
- `apps/api/src/categories/` (atualizar filtro)
- `apps/web/src/app/app/empresa/categorias/`
- `apps/web/src/components/categories/CategoryForm.tsx` (campo condicional)

**Critério de aceite:**

- Usuário `business` vê categorias empresariais padrão ao acessar `/app/empresa/categorias`.
- Usuário `individual` não vê categorias empresariais na sua lista.
- Criar categoria com centro de custo "TI" salva o campo corretamente.

**Requisito de origem:** §5.4, §7

**Fora de escopo:** Relatórios por centro de custo; hierarquia de centros de custo.

---

## Fase 5 — Evolução (pós-MVP)

> Os prompts abaixo estão fora do escopo do MVP. Executes-os apenas após o MVP estar estável e validado.

---

### P5.1 — Lançamentos recorrentes

**Objetivo:** Permitir criação de lançamentos com recorrência (diária, semanal, mensal, anual) e geração automática das ocorrências.

**Pré-requisitos:** MVP completo (P1–P4).

**Escopo / tarefas:**

- Adicionar campos ao model `Transaction`: `is_recurring` (boolean), `recurrence_rule` (string, formato iCal RRULE), `parent_transaction_id`.
- Criar worker/cron job em `apps/api` para gerar ocorrências futuras com base na regra de recorrência.
- Tela web: formulário de criação com opção "Repetir" (frequência + data de término).
- Ação "Editar esta ocorrência" vs "Editar todas as ocorrências futuras".

**Requisito de origem:** §15 Fase 5

---

### P5.2 — Metas e orçamentos

**Objetivo:** Permitir definição de metas de economia e orçamentos por categoria com acompanhamento de progresso.

**Pré-requisitos:** MVP completo.

**Escopo / tarefas:**

- Criar model `Budget`: `user_id`, `category_id`, `period` (monthly/yearly), `amount`, `start_date`.
- Endpoint `GET /budgets/status` retornando progresso (gasto vs orçado por categoria).
- Widget de orçamentos no dashboard mostrando barras de progresso.
- Alertas quando orçamento atingir 80% e 100%.

**Requisito de origem:** §15 Fase 5

---

### P5.3 — Relatórios

**Objetivo:** Implementar geração de relatórios financeiros por período, categoria e conta, com opção de exportação.

**Pré-requisitos:** MVP completo.

**Escopo / tarefas:**

- Endpoints de relatórios: por categoria, por conta, por período, DRE simplificado (business).
- Exportação para CSV.
- Tela de relatórios com filtros e visualização.
- Exportação para PDF (pode usar `puppeteer` ou biblioteca similar).

**Requisito de origem:** §15 Fase 5

---

### P5.4 — Importação de extratos bancários

**Objetivo:** Permitir importação de lançamentos via arquivo OFX/CSV de extratos bancários.

**Pré-requisitos:** MVP completo.

**Escopo / tarefas:**

- Endpoint `POST /transactions/import` aceitando multipart com arquivo OFX ou CSV.
- Parser de OFX e CSV mapeando campos para o modelo `Transaction`.
- Tela de importação com preview dos lançamentos antes de confirmar.
- Detecção de duplicatas por data + valor + descrição.

**Requisito de origem:** §15 Fase 5

---

### P5.5 — Notificações

**Objetivo:** Enviar notificações ao usuário sobre eventos relevantes (contas a vencer, orçamentos excedidos, resumo semanal).

**Pré-requisitos:** P5.2 concluído.

**Escopo / tarefas:**

- Criar `NotificationsModule` com tabela `notifications`.
- Tipos: conta a vencer em N dias, orçamento ≥ 80%, resumo semanal.
- Canal inicial: e-mail (via `nodemailer` ou serviço como Resend).
- Configuração de preferências de notificação por usuário.

**Requisito de origem:** §15 Fase 5

---

### P5.6 — Multiempresa e permissões por equipe

**Objetivo:** Permitir que um usuário `business` gerencie múltiplas empresas e convide membros de equipe com permissões por papel.

**Pré-requisitos:** MVP completo; P5.5 concluído.

**Escopo / tarefas:**

- Separar conceito de `Organization` de `User`.
- Model `OrganizationMember` com roles (`owner`, `admin`, `viewer`).
- Todos os recursos (contas, lançamentos, categorias) passam a ser escopados por `organization_id` em vez de `user_id`.
- Fluxo de convite por e-mail.
- Tela de gerenciamento de membros.

**Requisito de origem:** §15 Fase 5, §16

---

## Checklist de critérios de aceite do MVP (§17)

Mapeamento de cada critério de aceite para o(s) prompt(s) que o satisfaz(em):

| Critério de aceite (§17)                                                   | Prompt(s)                             |
| -------------------------------------------------------------------------- | ------------------------------------- |
| Usuário consegue criar conta e fazer login                                 | P2.1, P2.4                            |
| Usuários individual e business são direcionados para áreas distintas       | P2.2, P2.4                            |
| Usuário pessoa física consegue criar, editar, listar e filtrar lançamentos | P2.7, P2.8, P2.9                      |
| Dashboard exibe indicadores coerentes com os lançamentos                   | P2.10                                 |
| Agente Python recebe uma mensagem simulada de WhatsApp                     | P3.2                                  |
| Mensagem "gastei 100 no mercado" gera lançamento de despesa                | P3.3, P3.4, P3.6                      |
| Lançamento criado pela IA fica identificado com origem apropriada          | P3.6, P3.7                            |
| Mensagens ambíguas não criam lançamento sem confirmação                    | P3.5                                  |
| Dados de um usuário não ficam acessíveis para outro usuário                | P2.1, P2.7 (isolamento por `user_id`) |
