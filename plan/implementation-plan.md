# Plano: Gerar arquivo de prompts incrementais de implementação

## Contexto

O projeto `financial-vellun` é greenfield — atualmente só existe `docs/technical-requirements.md`. Esse documento descreve por completo a arquitetura (monorepo com `apps/web`, `apps/api`, `apps/ai-agent`), o modelo de dados, os módulos funcionais, requisitos não funcionais e um roadmap em 5 fases (§15).

O objetivo é produzir **um único arquivo Markdown** contendo prompts incrementais — lógicos, sequenciais e coesos — que poderão ser executados, um a um, para implementar a aplicação posteriormente. Cada prompt deve ser autossuficiente o bastante para ser colado em um agente de codificação e produzir um passo concreto e verificável, construindo sobre o anterior.

### Decisões confirmadas com o usuário
- **Idioma:** Português (BR), para manter consistência com o documento de requisitos.
- **Granularidade:** Um prompt por etapa do roadmap (Fases 1–5 do §15). Resultado esperado: ~30–40 prompts focados.
- **Defaults recomendados** (marcados como ajustáveis dentro dos prompts):
  - Gerenciador de pacotes: **pnpm workspaces** (monorepo).
  - Autenticação: **JWT (access + refresh)** com cookies HTTP-only.
  - Provedor de WhatsApp: **abstraído via adapter/interface** (sem acoplar a Z-API/Twilio/Meta).
  - Provedor de IA: **OpenAI** inicialmente, atrás de uma camada de abstração.

## Arquivo a ser criado

- `docs/implementation-prompts.md` (novo arquivo; único arquivo a ser escrito na fase de execução).

## Estrutura do documento de prompts

1. **Cabeçalho e instruções de uso**
   - Como usar os prompts (executar em ordem, validar o critério de aceite de cada um antes de seguir).
   - Convenções globais: stack por app, defaults escolhidos, padrões de commit, "definition of done" por prompt.
   - Tabela de rastreabilidade prompt → requisito (§ do technical-requirements).

2. **Bloco 0 — Convenções compartilhadas** (referência citada pelos prompts)
   - Tipos/enums compartilhados (`profile_type`, `transaction.type/status/source`, `account.type`), nomenclatura, formato de resposta de erro da API, padrão de validação (Zod).

3. **Prompts por fase do roadmap** (cada prompt segue o template abaixo):

   **Fase 1 — Fundação**
   - P1.1 Inicializar monorepo (pnpm workspaces, estrutura `apps/` `packages/` `infra/`).
   - P1.2 Configurar lint/format/TS base (`packages/config`).
   - P1.3 `packages/shared` com tipos/enums e schemas Zod compartilhados.
   - P1.4 Docker Compose com PostgreSQL (`infra/docker`).
   - P1.5 Bootstrap `apps/api` (NestJS + Prisma + Swagger + config por env).
   - P1.6 Schema Prisma inicial (todas as tabelas do §11) + migration + seed de categorias default.
   - P1.7 Bootstrap `apps/web` (Next.js + Tailwind + shadcn/ui + cliente HTTP tipado).
   - P1.8 Bootstrap `apps/ai-agent` (FastAPI + Pydantic + cliente HTTP para a API).

   **Fase 2 — Produto Pessoal**
   - P2.1 Auth na API: register/login/logout/refresh/me (§5.2), hash de senha, JWT, guards.
   - P2.2 Perfis individual/business + redirecionamento por `profile_type`.
   - P2.3 Landing page pública (§5.1).
   - P2.4 Telas de login/cadastro + proteção de rotas no web.
   - P2.5 CRUD de Categorias (API + web) com categorias default.
   - P2.6 CRUD de Contas (API + web) com saldo inicial/atual.
   - P2.7 CRUD de Lançamentos (API): tipos, status, source, validações e isolamento por usuário.
   - P2.8 Tela de lançamentos no web: tabela, filtros obrigatórios (§6), ordenação, paginação.
   - P2.9 Criação/edição manual de lançamentos no web.
   - P2.10 Endpoint de indicadores do dashboard + dashboard pessoa física (§5.3).

   **Fase 3 — IA e WhatsApp**
   - P3.1 Endpoints internos protegidos por chave interna (§10): contacts/:phone, transactions/from-ai, ai-events.
   - P3.2 Webhook (simulado) no `ai-agent` + identificação de contato por telefone.
   - P3.3 Interpretador de mensagens + schema `FinancialIntent` (§9.3) com nível de confiança.
   - P3.4 Camada LLM (OpenAI abstraído) para extração estruturada.
   - P3.5 Regras de confirmação para mensagens ambíguas (§9.4).
   - P3.6 Criação de lançamento confirmado via API interna com `source`/origem apropriada.
   - P3.7 Auditoria: persistir conversas, mensagens e extrações (§9.5 / §11.2 / §11.3).

   **Fase 4 — Pessoa Jurídica**
   - P4.1 Dashboard empresarial inicial + fluxo de caixa (§5.4).
   - P4.2 Contas a pagar e a receber (inicial).
   - P4.3 Clientes e fornecedores.
   - P4.4 Categorias empresariais (centro de custo).

   **Fase 5 — Evolução** (prompts de extensão, marcados como pós-MVP)
   - P5.1 Lançamentos recorrentes · P5.2 Metas e orçamentos · P5.3 Relatórios · P5.4 Importação de extratos · P5.5 Notificações · P5.6 Multiempresa/permissões.

4. **Seção final — Checklist de critérios de aceite do MVP** mapeando cada item do §17 ao(s) prompt(s) que o satisfaz(em).

## Template de cada prompt

Cada prompt terá:
- **Título e ID** (ex.: `P2.7 — CRUD de Lançamentos (API)`).
- **Objetivo** (1–2 frases).
- **Pré-requisitos** (IDs de prompts anteriores).
- **Escopo / tarefas** (lista de ações concretas).
- **Arquivos/áreas afetadas** (caminhos esperados no monorepo).
- **Critério de aceite** (verificável: endpoint responde, teste passa, tela renderiza).
- **Requisito de origem** (§ do technical-requirements).
- **Fora de escopo** (para evitar desvio).

## Verificação

Como este entregável é um documento (não código executável), a verificação será:
- Conferir que **todos os módulos do §5–§11 e todas as etapas do roadmap §15 têm prompt correspondente** (sem lacunas).
- Conferir que **cada critério de aceite do MVP (§17) está coberto** por ao menos um prompt na seção final de checklist.
- Conferir que a ordem é executável: nenhum prompt depende de algo criado por um prompt posterior (pré-requisitos sempre apontam para trás).
- Garantir consistência de nomes de entidades/enums com o §4, §6, §7, §8 e §11.
