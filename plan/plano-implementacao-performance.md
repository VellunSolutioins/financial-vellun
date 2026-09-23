# Plano de implementação — Performance, escalabilidade e disponibilidade

Data: 22/09/2026. **Base: branch `main`** (commit `2fca515`).
Origem: [recomendações de performance](../docs/financial-vellun-recomendacoes-performance-escalabilidade-disponibilidade.md),
analisadas em conjunto com a [análise de segurança](../docs/analise-seguranca-2026-09-21.md).
Plano irmão: [plano de implementação de segurança](plano-implementacao-seguranca.md).

> Itens que só se aplicam ao código da `feature/melhorias` (Análise Financeira, recorrências, índices
> para `createdByUserId`) estão na seção
> [Quando a feature/melhorias for integrada](#quando-a-featuremelhorias-for-integrada).

Decisões já tomadas:

- **Redis entra na API**, criado pelo plano de segurança (S2) e reaproveitado aqui para cache.
- **Posse do telefone** por reverse OTP: o usuário envia o código ao bot por link `wa.me` ou QR code.
  A boas-vindas passa a ser a resposta a essa mensagem e segue o mesmo caminho outbound das demais
  respostas. O endpoint `/internal/notifications/welcome`, chamado no cadastro, deixa de ser usado.

> ## Status (22/09/2026): P1–P6 implementados na branch `feat/seguranca-s1`
>
> Decisões e ajustes tomados na implementação, que corrigem o texto abaixo:
>
> - **P1 — readiness do Redis na API não reprova.** O contrato C8 ("dependência
>   indisponível → 503") está certo para o Postgres e errado para o Redis aqui:
>   a API degrada sem ele de propósito (rate limit em memória, cache
>   recalculado) e **todas** as réplicas olham a mesma instância. Falhar o
>   readiness tiraria todas do balanceador de uma vez, trocando uma degradação
>   planejada por um apagão. O estado real vai no corpo, em `state`
>   (`disabled | up | degraded`), que é o que o alerta lê. No worker do agente é
>   o oposto e continua assim: sem Redis não há lock nem agrupamento.
> - **P1 — `httpx` do `CloudApiMessenger`:** além de fechar no shutdown, o pool
>   passou a ser criado sob demanda; criá-lo na importação do singleton o
>   prendia a um event loop que ainda não existia.
> - **P2 — EXPLAIN pendente.** Script e formato do registro estão prontos
>   (`infra/database/explain-hot-queries.sql`,
>   `docs/explain-consultas-quentes.md`), mas a medição precisa de um Postgres
>   com volume representativo. **Os índices foram criados sem ela**, com a
>   justificativa de cada um na migration; o índice `[userId, createdAt]` é o de
>   argumento mais fraco e deve ser removido se o EXPLAIN não o justificar.
> - **P2 — contas a pagar/receber:** além do `take`, os totais passaram a vir de
>   uma agregação à parte. Só pôr `take` teria feito o card somar cinco itens e
>   exibir o resultado como total em aberto.
> - **P2 — `limit` ganhou teto** (`@Max(500)`): o parâmetro é público, e sem teto
>   `?limit=1000000` é uma varredura da tabela por request. 500 preserva a tela
>   de pendentes, que é quem pede mais hoje.
> - **P3 — aviso de DLQ não realimenta a fila.** Uma falha vinda de
>   `whatsapp.outbound.dlq` **não** gera aviso ao usuário: o aviso é uma mensagem
>   de WhatsApp entregue pela mesma fila que acabou de falhar. O cooldown por
>   telefone atrasaria o ciclo, não o impediria.
> - **P3 — `OpsFailureSource` ganhou `whatsapp_outbound`** (migration própria),
>   senão falhas de entrega seriam catalogadas como falhas de entrada — o que
>   muda o destino do reprocessamento.
> - **P3 — `userId`/`contactId` podem vir vazios** numa retomada: o texto
>   guardado em `job:reply:{jobId}` não carrega identidade, e reconsultá-la por
>   entrega seria uma chamada à API para preencher um campo de log.
> - **P4 — `internal_api_seconds` usa allowlist de rotas**, não uma heurística
>   que limpa o caminho: telefone e uuid aparecem no meio da rota, e errar
>   colocaria o número de alguém dentro de um **nome** de métrica — pior que
>   label livre, porque nome não se filtra depois.
> - **P4 — o contador de DLQ virou `dlq`**, incrementado na política de ack
>   (`dispatch`), que cobre os dois drivers. `dlq_messages` nunca existiu.
> - **P4 — idade da fila exigiu duas coisas a mais:** o publisher passou a
>   definir a propriedade AMQP `timestamp` (sem ela o plugin reporta 0) e o
>   Alloy passou a coletar a família `queue_metrics`.
> - **P5 — seed de carga é pré-requisito, não conveniência.** Sem contatos
>   verificados, toda mensagem da carga para em "número não vinculado" e o teste
>   mede o caminho errado. `apps/api/prisma/seed-loadtest.ts` cria os contatos, e
>   recusa rodar em produção ou contra banco não-local.
> - **P5 — execução pendente:** os perfis existem (`--profile 10/min` …
>   `1000/min`) e o runbook tem a tabela do capacity review, mas os números
>   ainda não foram coletados.
> - **P6 — PgBouncer entrou como perfil opcional** do compose
>   (`--profile pooler`), para exercitar o transaction mode localmente sem mudar
>   o `pnpm db:up` do dia a dia.
> - **P6 — timeout da OpenAI** era o padrão do SDK: 600s. Dez minutos segurando
>   um slot de concorrência e o lock do telefone. Agora 30s (60s para mídia).

## Estado atual na `main`

**Agente e pipeline**

- O worker **não** é um serviço separado no Railway: `RUN_CONSUMERS_IN_API=true` é o default
  (`config.py:88`). O `worker.py` existe e expõe health e metrics em `:8011`.
- A resposta ao WhatsApp é enviada **antes do ACK**: `_process` (`processing_consumer.py:135-156`)
  chama `message_processor.deliver` (:152) e só depois marca `job:done` (:156).
- Outros envios diretos no caminho crítico:
  - `inbound_consumer.py:133` e `:142` (número não vinculado e assinatura bloqueada);
  - `dlq_catalog_consumer.py:140` (aviso de falha ao usuário).
- Categorias e contas são buscadas duas vezes por job: em `message_processor.py:329-332` e de novo em
  `transaction_creator.py:104` e `:126`. Não há cache.
- **httpx:** o client de mídia é criado a cada download (`whatsapp_media.py:28-29`), e o client do
  `CloudApiMessenger` nunca é fechado.
- **Scripts:** `monitor.py:108` e `loadtest.py:359` leem o contador `dlq_messages`, que não existe.

**Banco**

- **Índices:** `AiConversation` não tem índice, embora seja consultada por
  `{whatsappContactId, status: 'active'}` ordenado por `createdAt` (`internal.service.ts:109` e `:388`,
  este dentro de `SELECT ... FOR UPDATE`). `WhatsappContact.userId` não tem índice. `Transaction` só
  tem índices de uma coluna (`schema.prisma:284-288`), nenhum com `status`.
- **Queries:**
  - `getMonthlyComparison` (`dashboard.service.ts:235-263`, chamado com 12 meses em :68) faz 12 rodadas sequenciais de 2 agregações, ou seja, 24 queries por request;
  - na visão empresarial, as listas de contas a receber e a pagar não têm `take` (`dashboard.service.ts:113-122`);
  - a listagem de lançamentos usa `limit = 20` por padrão (`list-transactions.dto.ts:59`), contra a regra de 10 itens do CLAUDE.md.
- **Prisma:** sem `connection_limit`, sem pooler e sem shutdown hook (`prisma/prisma.service.ts`). O
  readiness da API só checa Postgres.

**Infra:** sem `railway.toml` e sem CI.

## Contrato de coordenação com o plano de segurança

> Seção idêntica nos dois planos. Cada decisão tem **um dono**; o outro plano apenas consome.

| #   | Tema                                 | Dono                                                                         | Regra acordada                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Redis na API                         | Segurança (S2)                                                               | `RedisModule` em `apps/api/src/redis/` (ioredis). Prefixos `rl:` (throttler) e `cache:` (performance). Mesma instância do agente, prefixos separados.                                                                                                                                                                                        |
| C2  | Revogação de sessão sem custo extra  | Segurança (S1)                                                               | A validação da sessão substitui a leitura de usuário que já existe na `jwt.strategy` (1 query com `include`). **Sessão e usuário nunca vão para cache.**                                                                                                                                                                                     |
| C3  | Identidade por telefone              | Segurança (S1)                                                               | `GET /internal/whatsapp/contacts/:phone` e `subscription-access` **não são cacheáveis** (nem no agente, nem na API). Performance otimiza com memo por job e índices.                                                                                                                                                                         |
| C4  | Estado conversacional pendente       | Segurança (S1)                                                               | `conv:{phone}` passa a guardar `userId`, `contactId` e `linkVersion`. Ao concluir uma confirmação o agente re-resolve a identidade e descarta o estado se divergir. A API não precisa apagar chaves do agente.                                                                                                                               |
| C5  | Fila outbound                        | Performance (P3)                                                             | Contrato `OutboundMessageV1` em `messaging/contracts.py` com `schemaVersion`, `userId`, `contactId`, `jobId`. Toda resposta, inclusive a boas-vindas enviada após o reverse OTP, passa por ela quando existir. O outbound worker só envia; não decide identidade.                                                                            |
| C6  | Migrations Prisma                    | Ambos                                                                        | Migrations pequenas e separadas (`YYYYMMDDHHMMSS_snake_case`). Segurança: `user_sessions`, `phone_verifications`, campos de vínculo em `whatsapp_contacts` (`verified_at`, `revoked_at`, `link_version`) e `@@index([userId])` nela. Performance: índices de `Transaction` e `AiConversation`. Nenhum plano cria índice que o outro já cria. |
| C7  | PgBouncer × transações atômicas      | Performance (P2)                                                             | Pool em _transaction mode_ com `pgbouncer=true` e `directUrl` para migrations. As operações atômicas da segurança usam transação interativa ou `updateMany` condicional, **sem** advisory lock de sessão, `LISTEN` ou prepared statements nomeados.                                                                                          |
| C8  | Config inválida × readiness          | Segurança (S1) define boot; Performance (P1) define readiness                | Configuração inválida ou insegura → **falha no boot**. Dependência indisponível → **readiness 503**.                                                                                                                                                                                                                                         |
| C9  | Webhook assinado × loadtest          | Segurança (S1)                                                               | Bypass de assinatura só com `WEBHOOK_ALLOW_UNSIGNED=true` **e** ambiente local. `scripts/loadtest.py` passa a assinar os payloads com HMAC.                                                                                                                                                                                                  |
| C10 | docker-compose, Dockerfile, Railway  | Segurança define as regras (S1/S3); Performance adiciona serviços (P1/P2/P6) | Portas em `127.0.0.1`, Redis com senha, RabbitMQ sem `guest`; serviços novos (PgBouncer) seguem as mesmas regras. Dockerfile do agente com `USER` não-root serve HTTP e worker. `railway.toml` (performance) inclui o checklist de rede privada (segurança).                                                                                 |
| C11 | Escalar a API horizontalmente        | Performance (P6)                                                             | **Bloqueado até** throttler em Redis + `trust proxy` (S2).                                                                                                                                                                                                                                                                                   |
| C12 | Rate limit por usuário/telefone      | Segurança (S2)                                                               | Limites calibrados acima do perfil de loadtest (P5); o loadtest usa muitos telefones distintos. Rejeições por limite viram métrica.                                                                                                                                                                                                          |
| C13 | Métricas                             | Ambos                                                                        | Mesmo registry (`services/metrics.py` no agente; `observability/` na API), prefixos `vellun_agent_*` / `vellun_api_*`, sem telefone ou PII em labels.                                                                                                                                                                                        |
| C14 | Retenção de `AiMessage` / `rawInput` | Segurança (S4)                                                               | Job de purga em lotes pequenos, fora de pico, dentro do connection budget (P2).                                                                                                                                                                                                                                                              |
| C15 | Integração da `feature/melhorias`    | Ambos                                                                        | Os planos valem para a `main`. Ao integrar a `feature/melhorias`, aplicar os itens da seção "Quando a feature/melhorias for integrada" de cada plano antes do merge em produção.                                                                                                                                                             |

**Ordem global intercalada:** S1 → P1 → S2 → P2 → P3 → S3 → P4/P5 → S4 → P6.

---

## P1 — Isolamento de workloads e readiness (doc §4, §16)

- **Railway:**
  - serviço `ai-agent` (HTTP) com `RUN_CONSUMERS_IN_API=false`;
  - novo serviço `ai-agent-worker` com a mesma imagem (`Dockerfile.ai-agent`) e o comando `python -m src.worker`;
  - a porta 8011 do worker serve só health e metrics, sem domínio público (C10).
- Validar o drain no deploy (`SHUTDOWN_DRAIN_SECONDS`) e que o HTTP continua respondendo 202 durante o deploy do worker.
- **Readiness (C8):**
  - HTTP do agente: publisher do broker (já em `bootstrap.readiness`);
  - worker: RabbitMQ, Redis e flusher;
  - API `/health/ready` (`observability/health.controller.ts:35`): Postgres e, após C1, Redis.
- Fechar o `httpx` do `CloudApiMessenger` no shutdown do pipeline (`bootstrap.py`).

## P2 — PostgreSQL (doc §5, §6, §10)

- **Medir** com `EXPLAIN (ANALYZE, BUFFERS)` as consultas quentes:
  - listagem (`transactions.service.ts:25-72`);
  - dashboard pessoal (`dashboard.service.ts:23-46`) e empresarial (`:90-122`);
  - série diária (`dashboard.service.ts:204-212`);
  - conversa ativa (`internal.service.ts:109`, `:388`).
- **Migration de índices (C6):**
  - `Transaction @@index([userId, transactionDate])`, que atende listagem e série diária;
  - `Transaction @@index([userId, status, type, transactionDate])`, que atende agregações e pendentes;
  - `Transaction @@index([userId, createdAt])`, para "lançamentos recentes" (`dashboard.service.ts:40-45`), se o EXPLAIN justificar;
  - `AiConversation @@index([whatsappContactId, status, createdAt])`;
  - remover índices de uma coluna que ficarem redundantes (`userId`, talvez `type` e `transactionDate`), só depois de confirmar com o EXPLAIN.
- **Quick wins de query:**
  - `getMonthlyComparison`: trocar as 24 queries por uma agregação única com
    `date_trunc('month', transaction_date)` e `GROUP BY type` (`$queryRaw` tipado);
  - pôr `take` e paginação nas contas a receber e a pagar (`dashboard.service.ts:113-122`);
  - listagem com `limit = 10` por padrão (`list-transactions.dto.ts:59`), conforme o CLAUDE.md, ajustando o web junto.
- **Pooling:**
  - documentar o connection budget (infra/admin, API, workers, outros);
  - `connection_limit` e `pool_timeout` na `DATABASE_URL`;
  - PgBouncer ou pooler do provedor em transaction mode, com `directUrl` para migrations (C7);
  - `enableShutdownHooks` / `$disconnect` no `PrismaService`.

## P3 — Outbound assíncrono (doc §7)

- **Contrato e topologia (C5):**
  - `OutboundMessageV1` em `contracts.py`;
  - filas `whatsapp.outbound.v1`, `whatsapp.outbound.retry.{1,4,16,60,300}s` e `whatsapp.outbound.dlq`;
  - reaproveitar `names.py`, `topology.py` e `retry.py`.
- **Processing:** `_process` (`processing_consumer.py:135-156`) persiste, publica a mensagem outbound
  no lugar do `deliver` (:152) e dá ACK. A publicação é idempotente por `jobId` e reaproveita
  `job:reply:{jobId}` (`reply_key`, :55).
- **Demais envios diretos:** `inbound_consumer.py:133, 142`, `dlq_catalog_consumer.py:140` e a
  boas-vindas pós-verificação (S1.1) também publicam na fila outbound.
- **Outbound consumer (no worker):**
  - usa `CloudApiMessenger`;
  - 429 e 5xx → retry; outros 4xx → DLQ;
  - concorrência própria (`OUTBOUND_CONSUMER_CONCURRENCY`) dentro do rate limit da Meta;
  - catálogo de falhas reaproveitado do DLQ existente.
- **Rollout** atrás de flag, no padrão da ADR-0009, e registrado numa nova ADR.

## P4 — Métricas de capacidade e SLO (doc §8, §15, §17)

- **Novas métricas no agente (C13):**
  - `message_end_to_end_seconds`, do recebimento no webhook ao envio pelo outbound;
  - `outbound_send_seconds`;
  - `internal_api_seconds`, por rota agregada.
- **Idade da mensagem mais antiga e backlog** por fila via `rabbitmq_detailed_*` no Alloy, com alertas
  em `infra/observability/alerts/`. Incluir as filas outbound.
- **GroupFlusher:** contadores `flusher_polls` e `flusher_groups_found`, para decidir no futuro se vale sair do polling.
- **Utilização de conexões** do Postgres e do pool.
- **Corrigir `dlq_messages`** em `monitor.py:108` e `loadtest.py:359`: usar um contador real de DLQ,
  incrementado no driver RabbitMQ.

## P5 — Teste de carga e capacity review (doc §20 fase 5, §21)

- `loadtest.py` assina os payloads com HMAC (C9) e usa telefones distintos (C12).
- Os telefones do loadtest precisam estar `verified` (S1.1): o seed de carga cria os contatos já verificados.
- Perfis de 10, 100, 500 e 1000 mensagens/min, com o LLM mockado e com o real.
- Medir p50, p95 e p99, backlog, drain time, CPU, memória, conexões Postgres e Redis e latência da OpenAI.
- Registrar no runbook o capacity review por etapa: operações Redis, queries SQL e chamadas HTTP por mensagem.

## P6 — Tuning, cache seletivo, escala e IaC (doc §9, §11, §12, §18)

- **Cache seletivo:**
  - primeiro, memo por job de categorias e contas no agente (`message_processor.py:329-332` →
    `transaction_creator.py:104, 126`): elimina chamadas duplicadas sem risco de consistência;
  - só se a medição justificar, `cache:categories:{userId}` / `cache:accounts:{userId}` na API (Redis, C1), invalidado nas escritas;
  - **nunca** identidade, assinatura ou sessão (C2, C3).
- **Redis como infraestrutura de estado:** `maxmemory-policy noeviction`, AOF, alertas de memória e plano de recuperação.
- **Concorrência:**
  - ajustar `RABBITMQ_PREFETCH`, as concorrências e o número de workers com base em P4/P5;
  - respeitar `workers × concorrência ≤ capacidade downstream`;
  - timeouts e `max_retries` explícitos nos clients da OpenAI.
- **Escala:** réplicas da API só depois de S2 (C11); escalar workers por idade e backlog da fila.
- **IaC:**
  - `railway.toml` por serviço: start command, healthcheck, restart policy e réplicas;
  - checklist de rede privada (C10);
  - variáveis documentadas nos `.env.example`.

## Quando a feature/melhorias for integrada

Itens que dependem de código que só existe na `feature/melhorias`. Aplicar ao integrar (C15):

- **Análise Financeira** (`financial-analysis.service.ts`): busca 6 meses de lançamentos confirmados.
  Entra no EXPLAIN de P2 e é atendida pelo índice `[userId, status, type, transactionDate]`.
- **`createdByUserId`** (autoria do lançamento no plano Duo): avaliar índice só se houver filtro
  frequente por ele na listagem.
- **Endpoints `*/from-ai`** novos (recorrências, metas, caixinhas, cartões, lembretes, agenda, notas):
  entram no capacity review (P5) e na métrica `internal_api_seconds` (P4).
- **Dashboard:** o `dashboard.service.ts` da `feature/melhorias` difere da `main`. Refazer o EXPLAIN
  e a otimização de `getMonthlyComparison` sobre a versão integrada.

## Critérios de aceite

- EXPLAIN antes e depois registrado para cada índice novo.
- `getMonthlyComparison` com 1 query em vez de 24, com o mesmo resultado (teste comparando as duas versões).
- Nenhuma regressão nos testes jest e pytest.
- Com o WhatsApp indisponível (mock 503), o processing continua e o backlog cresce só em `whatsapp.outbound.v1`.
- Deploy do worker sem perda de mensagens, com o HTTP respondendo 202 durante o deploy.
- Loadtest reporta p95 fim a fim e drain time em cada perfil.

## Rastreabilidade

| Recomendação do documento             | Passo                 |
| ------------------------------------- | --------------------- |
| §4 Separar HTTP e workers             | P1                    |
| §5 Índices de `Transaction`           | P2                    |
| §6 Índice de conversas                | P2                    |
| §7 Outbound assíncrono                | P3                    |
| §8 Escala por backlog                 | P4, P6                |
| §9 Controle de concorrência           | P6                    |
| §10 Connection budget e pooling       | P2                    |
| §11 Cache seletivo                    | P6                    |
| §12 Redis como infraestrutura crítica | P6                    |
| §13 Lock por telefone                 | mantido (sem mudança) |
| §14 RabbitMQ                          | mantido; tuning em P6 |
| §15 Observabilidade e SLOs            | P4                    |
| §16 Readiness                         | P1                    |
| §17 GroupFlusher                      | P4 (medição)          |
| §18 Infra declarativa                 | P6                    |
| §20–21 Carga e capacity review        | P5                    |
