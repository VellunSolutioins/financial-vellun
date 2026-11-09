# Plano — escrever o documento de migração para a AWS

## Contexto

O Financial Vellun roda hoje no Railway (API, agente HTTP, worker, Alloy, Postgres, RabbitMQ,
Redis) e na Vercel (web). O Bruno quer migrar tudo para a AWS e pediu um documento que descreva
o que precisa ser feito. Este plano cobre **só a escrita desse documento** — nenhuma mudança de
código ou de infraestrutura acontece agora.

Decisões já tomadas com o Bruno:

| Tema        | Decisão                                                            |
| ----------- | ------------------------------------------------------------------ |
| Arquitetura | Gerenciada: ECS Fargate + RDS PostgreSQL + Amazon MQ + ElastiCache |
| Frontend    | Container no Fargate, mesmo cluster/ALB/pipeline da API            |
| Região      | `sa-east-1` (São Paulo)                                            |
| Domínio     | Ainda não existe; será registrado (pré-requisito no documento)     |

## Entregável

Um arquivo novo: `plan/migracao-para-aws.md`, em português, no formato dos outros planos da
pasta (`plan/recuperacao-de-senha-por-email.md` é a referência: aviso de status no topo,
"Contexto", tabelas, passos numerados, "Verificação"). Leitor: quem vai executar a migração,
conhece o projeto e não necessariamente a AWS.

Nenhum outro arquivo é alterado. A atualização de `CLAUDE.md`, `README.md`, `infra/railway/` e
dos docs de operação entra no documento como tarefa pós-migração, não é feita agora.

## Estrutura do documento

1. **Status e decisões** — "Não implementado", data, tabela de decisões acima.
2. **De → para** — tabela mapeando cada peça atual ao equivalente na AWS (4 serviços de app,
   Alloy, Postgres, RabbitMQ, Redis, rede privada, variáveis, deploy, logs, domínio).
3. **Arquitetura alvo** — diagrama ASCII: Route 53 → ALB (ACM) → `app.` web / `api.` API /
   `webhook.` agente; worker e Alloy sem entrada pública; RDS, Amazon MQ e ElastiCache em
   subnets privadas; saída por NAT para OpenAI, Meta, Asaas, Resend, GitHub e Grafana Cloud.
4. **Pré-requisitos** — conta AWS com MFA e alarme de orçamento, registro do domínio,
   Terraform com estado em S3, acesso de dump ao Postgres do Railway.
5. **Mudanças no repositório** (lista abaixo).
6. **Infraestrutura por componente** (lista abaixo).
7. **Variáveis de ambiente que mudam** — tabela por serviço.
8. **Plano de corte e rollback** (lista abaixo).
9. **Pós-migração** — desligar Railway/Vercel, docs a atualizar, primeiro ensaio de restauração.
10. **Custos** — estimativa mensal por componente e alavancas de redução.
11. **Riscos e pontos a validar antes de começar**.
12. **Fases de execução** — F0 a F6, cada uma com critério de aceite.

## Conteúdo já levantado, por seção

### Mudanças no repositório (seção 5)

- **`Dockerfile.api`** (não existe; hoje é Nixpacks): multi-stage com pnpm workspace,
  `prisma generate`, usuário sem privilégio, mesmo padrão do `Dockerfile.ai-agent`.
- **`Dockerfile.web`** (não existe): `output: 'standalone'` em `apps/web/next.config.js`.
  `NEXT_PUBLIC_API_URL` é embutido no build (também alimenta a CSP), então vira build arg.
- **Origem do web fixa no código**: `PRODUCTION_WEB_ORIGIN` em
  `apps/api/src/common/http-origin.util.ts` e o padrão de `web_url` em
  `apps/ai-agent/src/config.py` apontam para `financial-vellun-web.vercel.app`; a regex de
  preview da Vercel e os specs correspondentes saem junto.
- **Cookies**: `sameSite: 'none'` em `apps/api/src/auth/session.service.ts` e
  `apps/api/src/ops/auth/ops-session.service.ts` existe por causa do cross-site. Com
  `app.` e `api.` no mesmo domínio registrável, passa a `lax`.
- **Keep-alive atrás do ALB**: o timeout ocioso do ALB (60 s) é maior que o padrão do Node e do
  uvicorn (5 s), o que gera 502 esporádico. Ajustar em `apps/api/src/main.ts`, no start do web
  e no `--timeout-keep-alive` do uvicorn.
- **`infra/observability/alloy/config.alloy`**: trocar os alvos `*.railway.internal`, o label
  `cluster = "railway"` e o scrape do RabbitMQ.
- **RabbitMQ 4**: `apps/ai-agent/src/messaging/rabbitmq/topology.py` declara filas sem
  `x-queue-type`; subir compose e CI para a versão alvo e fixar o tipo explicitamente.
- **CI/CD**: novo workflow de deploy (OIDC → ECR → ECS); `.github/workflows/ci.yml` hoje só
  verifica.
- **`infra/aws/`**: Terraform novo; `infra/railway/` fica até o corte.

### Infraestrutura (seção 6)

- **Rede**: VPC em 2 AZs, subnets públicas (ALB, NAT) e privadas (tasks e dados), um security
  group por serviço reproduzindo o checklist C10 de `infra/railway/README.md`.
- **ECS Fargate**: tabela com os 5 serviços (web, api, ai-agent, ai-agent-worker, alloy) —
  porta, público ou não, health check, `stopTimeout`. Pontos específicos:
  - o ECS ignora o `HEALTHCHECK` do Dockerfile; o worker precisa de health check na task;
  - `overlapSeconds` vira deploy rolling 100/200% + `stopTimeout` acima de
    `SHUTDOWN_DRAIN_SECONDS` (20 s);
  - o ALB sonda continuamente, o Railway só no deploy — `/health/ready` passa a reciclar tasks
    quando uma dependência cai;
  - nomes internos por Service Connect/Cloud Map no lugar de `*.railway.internal`;
  - `prisma migrate deploy` continua no start da API (1 réplica).
- **RDS PostgreSQL 16**: Multi-AZ, backup automático com PITR (preenche a tabela "a definir" de
  `docs/retencao-e-backups.md`), `timezone` no parameter group, TLS na URL, recriar
  `vellun_monitor`. Connection budget atual (pico 19) cabe; sem RDS Proxy por ora.
- **Amazon MQ (RabbitMQ)** — verificado na documentação da AWS em 2026-10-11:
  - 3.13 roda em `mq.t3`/`m5`/`m7g`, mas **não** expõe endpoint Prometheus;
  - 4.2/4.3 só em `mq.m7g`, expõe `/metrics` e `/metrics/detailed` (HTTPS, basic auth, porta
    16001), o tipo padrão de fila vira `quorum` e não há métrica por fila no CloudWatch;
  - recomendação do documento: 4.x, para manter os alertas por fila do pipeline, com a
    validação de quorum queues como pré-requisito; 3.13 fica como alternativa documentada;
  - conexão só por `amqps://`.
- **ElastiCache**: não há AOF. O documento recomenda primário + réplica Multi-AZ com
  `noeviction`, e registra que a durabilidade nova do Valkey 9 exige cluster mode (mudança de
  cliente) e que `docs/tuning-e-escala.md` precisa ser reescrito nesse ponto.
- **Segredos**: SSM Parameter Store/Secrets Manager referenciados na task definition; rotação
  de tudo no corte.
- **Observabilidade**: Alloy como serviço Fargate, stdout em CloudWatch Logs com retenção
  definida, Grafana Cloud inalterado.
- **Borda**: um ALB com roteamento por host, certificado ACM, `TRUST_PROXY=1` mantido.

### Plano de corte (seção 8)

1. Ensaio: subir a AWS inteira com banco vazio e depois com um dump, medindo o tempo.
2. Janela: parar o agente HTTP no Railway, drenar as filas até zero, parar worker e API.
3. `pg_dump` → `pg_restore` no RDS; `db:verify:restore` e `db:verify:financial-model`.
4. Subir os serviços na AWS e rodar o smoke test.
5. Reapontar: webhook da Meta, webhook do Asaas, callback do OAuth App do GitHub (`/ops`),
   DNS do remetente de e-mail; redirecionamento do domínio antigo da Vercel.
6. Ponto de não retorno e rollback: antes da primeira escrita na AWS, voltar é religar o
   Railway; depois, exige dump reverso.

Efeitos a avisar: todos os usuários são deslogados (os cookies pertencem ao domínio antigo da
API); o Redis não é migrado (estado de TTL curto, confirmações pendentes se perdem).

## Passos de execução

1. Reler os trechos que o documento cita para fixar nomes e linhas exatas (`session.service.ts`,
   `config.alloy`, `plan/operacoes-e-observabilidade-plan.md`, ADR 0010).
2. Consultar os preços atuais de `sa-east-1` (Fargate, RDS, Amazon MQ `mq.m7g`, ElastiCache,
   NAT, ALB) e os tipos de instância disponíveis na região, registrando a data da consulta.
3. Conferir na documentação o comportamento de retentativa dos webhooks da Meta e do Asaas, que
   sustenta o passo 2 do corte.
4. Escrever `plan/migracao-para-aws.md` seguindo a estrutura acima.

## Verificação

- Todo caminho de arquivo citado no documento existe no repositório (Glob por cada um).
- Toda afirmação sobre serviço da AWS tem data de conferência e link, como em
  `docs/observability.md`; o que não foi possível confirmar aparece na seção de riscos como
  "a validar", não como fato.
- `pnpm exec prettier --check plan/migracao-para-aws.md` passa.
- As quatro decisões da tabela inicial aparecem refletidas em todas as seções (nenhum trecho
  descrevendo Amplify, EC2 única, `us-east-1` ou operação sem domínio).
