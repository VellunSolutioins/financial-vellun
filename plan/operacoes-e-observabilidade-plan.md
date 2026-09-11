# Área de operações e observabilidade

## Contexto

O produto processa dinheiro por dois caminhos assíncronos — o pipeline WhatsApp (RabbitMQ) e os
webhooks do PSP — e hoje **não há como saber que algo falhou**, muito menos recuperar. Quando uma
mensagem cai na DLQ ou um webhook de pagamento esgota tentativas, o único sinal é uma linha de log
num terminal, e a única "ferramenta" é o painel do RabbitMQ com credencial compartilhada.

O diagnóstico do repositório desmentiu três premissas do pedido original:

1. **API e agente não têm nada implantado no repositório.** Zero CI, zero IaC, nenhum Dockerfile para
   API ou web, nenhum gestor de segredos. O único host comprovado é o frontend na Vercel
   (`financial-vellun-web.vercel.app`, org `vellun-s-projects`, hard-coded em
   `apps/api/src/common/http-origin.util.ts:5`). O próprio repo mantém "Estratégia de deploy" como
   decisão em aberto (`docs/technical-requirements.md:720`).
2. **Não existe nenhuma noção de papel ou permissão.** `User` não tem `role`/`isAdmin`, o JWT carrega
   só `sub` e `email`, e não há `RolesGuard`, `@Roles`, `@Public` nem `@CurrentUser`. O `/internal/*`
   é chave compartilhada **sem identidade de chamador** — hoje é impossível auditar quem agiu.
3. **A API — justamente a que move dinheiro — tem observabilidade zero.** Health é `GET /` estático
   que responde `ok` com o banco fora; sem `/metrics`; sem log de requisição (nenhum interceptor,
   middleware ou exception filter); `correlationId` tem zero ocorrências em `apps/api/`. O agente
   Python está bem mais servido, com `/health/live`, `/health/ready` e `/metrics`.

O objetivo é fechar essas três lacunas na ordem em que uma habilita a outra: identidade e
autorização primeiro, instrumentação depois, coleta e alertas em seguida, e só então a operação
(catálogo de falhas, reprocessamento, auditoria).

### Decisões confirmadas

| Decisão                       | Escolha                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| Hospedagem de API e agente    | **Railway** (PaaS gerenciado)                                                           |
| Identidade dos operadores     | **GitHub OAuth + pertencer à org `VellunSolutioins`**, 2FA imposto pela política da org |
| Stack de observabilidade      | **Grafana Cloud** (free tier) — sem infra nova para manter                              |
| Retry de webhook de pagamento | **Corrigir a durabilidade antes** de construir a recuperação                            |

---

## Estado da implementação (2026-09-10)

Implementado até a **Entrega 7**, na branch `feat/whatsapp-durable-messaging`, um
commit por entrega.

| Entrega                                                  | Status             | Commit                                                                      |
| -------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| Achado 1 — dedup do inbound engolindo mensagem           | ✅                 | `corrigir perda de mensagem quando o agrupamento falha depois de persistir` |
| **0 — Identidade e autorização** (inclui Achado 2, CSRF) | ✅                 | `adicionar identidade e autorizacao da area de operacoes`                   |
| **1 — Instrumentação**                                   | ✅                 | `instrumentar API e agente com metricas, health e log estruturado`          |
| **2 — Coleta (Alloy)**                                   | ✅                 | `adicionar coleta de metricas e logs com Alloy e exporters`                 |
| **3 — Dashboards e alertas**                             | ✅                 | `adicionar dashboards e alertas versionados e testados`                     |
| **4 — RabbitMQ Management como ponte**                   | ✅                 | `documentar o uso do RabbitMQ Management como ponte para a DLQ`             |
| **5 — Catálogo de falhas**                               | ✅                 | `adicionar catalogo de falhas em Postgres`                                  |
| **6 — Painel de operações**                              | ✅                 | `adicionar painel de operacoes`                                             |
| **7 — Reprocessamento e auditoria**                      | ✅                 | `adicionar reprocessamento de falhas`                                       |
| **8 — Webhooks de pagamento** (inclui Achado 4)          | 🔜 Próxima         | última desta leva                                                           |
| 9 — Rastreamento distribuído                             | ⏸️ Fora desta leva | por decisão, ver escopo acordado                                            |

Achado 3 (`/internal/*` sem identidade de chamador) segue como dívida, conforme o
próprio plano previa.

Suítes ao final da Entrega 7: **343 na API**, **194 no agente**, **10 de
integração**, mais `pnpm obs:check` (20 regras de alerta, 33 casos de teste).

### Premissas do plano que se mostraram erradas

Verificadas contra documentação oficial ou contra o sistema no ar, e corrigidas:

1. **O Railway não tem log drain** (Entrega 2). As aplicações passaram a empurrar
   para o `loki.source.api` do Alloy, com transporte que nunca interrompe a
   aplicação, nunca bloqueia e nunca cresce sem limite. Ver `docs/observability.md`.
2. **O Grafana Cloud não suporta provisionamento por arquivo** (Entrega 3). Regras
   em formato Prometheus, carregadas com `mimirtool rules load`. Ganho colateral:
   viraram testáveis com `promtool test rules`.
3. **A porta 15692 do RabbitMQ agrega por padrão** (Entrega 3). Sem o label
   `queue`, os dois alertas centrais seriam inexprimíveis. Resolvido com dois
   scrapes de `/metrics/detailed`, pedindo só duas famílias (77 séries).
4. **O dominante de cardinalidade era o RabbitMQ, não a API** (Entrega 2). Medido:
   5.455 séries, 2.682 do RabbitMQ (2.464 só de `erlang_vm_*`). Com os descartes:
   **2.274 séries, 23% do teto de 10.000**.
5. **`requeue = Yes` não alterou a ordem** (Entrega 4). O plano afirmava que
   alteraria; medido no RabbitMQ 3.13.7, a ordem se manteve em três repetições.
   Documentado como "provavelmente preservada", nunca como invariante.

### Bugs encontrados e corrigidos no caminho

- **O interceptor de métricas contava erro como sucesso** (Entrega 1): lia
  `response.statusCode` antes do filtro de exceção, então os `503` do readiness
  apareciam como `200`.
- **Guard e pipe rodam antes dos interceptores** (Entrega 1), então `401` e `403`
  não apareciam em métrica nenhuma. O filtro passou a contabilizá-los.
- **O runbook induzia perda de dado** (Entrega 4): mandava remover da DLQ com
  `Get messages` + `requeue = No`, o que remove a **cabeça da fila**, não a
  mensagem republicada. Medido e reescrito.
- **`build_dlq_envelope` nunca copiava `first_failed_at`** (Entrega 4), então o
  envelope saía com `firstFailedAt` nulo — o único campo que distingue "falhou
  agora" de "vem falhando há horas".
- **A Entrega 5 cegava um alerta**: `NovaEntradaEmDLQ` olhava a profundidade da
  fila, e o catálogo a drena em segundos. Passou a olhar o contador do catálogo.
  `CatalogoDeFalhasDivergindoDaDLQ` foi removido — subtraía contador cumulativo de
  um gauge, e o resultado não significava nada.

### Onde retomar: Entrega 8 (webhooks de pagamento)

As Entregas 6 e 7 fecharam o pipeline WhatsApp de ponta a ponta — ler, agir e
auditar. O que existe:

- **Reprocessar** (`POST /ops/failures/:id/reprocess` e o lote em
  `POST /ops/failures/reprocess`) e **descartar**
  (`POST /ops/failures/:id/discard`), com justificativa obrigatória;
- o agente publica em `POST /internal/ops/reprocess`, com allowlist de rota,
  revalidação do contrato e _publisher confirm_;
- `ReprocessReconciliationService` devolve a `pending` o que ficar preso em
  `reprocessing` por mais de 15 min.

Falta da Entrega 8: `payment_webhook_events` ainda é uma ilha (Achado 4) — sem
relação com `Subscription`/`User`/`Payment` e **sem índice por `receivedAt`**, o
que a listagem de pagamentos do painel já exercita. A recuperação de um evento
`failed` depende de corrigir antes a durabilidade do retry, e esbarra num limite
já conhecido: `sanitizePayload` redige antes de persistir, então um evento que
precise de campo redigido não é recuperável sem consultar o PSP.

### O que a Entrega 7 mudou de rumo

- **O furo de deduplicação que bloqueava esta entrega já estava corrigido** no
  Achado 1. A lista de "Achados que precisam de correção" mais abaixo é o texto
  original do plano e não foi reescrita — a tabela de status é a fonte de verdade.
- **A API não publica no broker; o agente publica.** Duplicar a camada de
  mensageria em TypeScript significaria manter duas implementações de confirm,
  topologia e contratos. A API chama `POST /internal/ops/reprocess`, no mesmo
  sentido que já existia para as boas-vindas.
- **O código de status do agente virou contrato.** `422` é recusa antes de
  publicar (certeza de que nada entrou: a linha volta a `pending`); `503` é
  ambíguo, porque um confirm que não chega não prova que a publicação não
  aconteceu — a linha fica em `reprocessing` para o cron. `408` e `429` contam
  como ambíguos, não como recusa.
- **O lote é sequencial.** Concorrência compraria pouco e custaria a precisão da
  interrupção: "parou no item 7" vira "parou entre o 5 e o 12", e é essa
  fronteira que o operador usa para retomar.
- **Descartar ficou restrito a `pending`.** Uma linha em `reprocessing` pode já
  ter sido publicada; descartá-la diria "não vamos atender" sobre uma mensagem
  que talvez esteja sendo processada. O cron devolve essas a `pending` primeiro.
- **"Republicada" não é "processada com sucesso"**, e a tela diz isso. O catálogo
  não acompanha o pipeline depois da publicação; o que ele sabe é se a mesma
  correlação voltou a falhar, e é isso que `subsequentFailures` mostra.

### Duas medições que desmentiram a sonda, não o código

1. **O `messages` do RabbitMQ Management vem de coleta periódica (~5s).** Ler a
   profundidade logo após publicar devolve o valor **anterior** — a primeira
   rodada da verificação mostrou "fila = 0" depois de duas publicações
   confirmadas. O contador cumulativo `message_stats.publish` já mostrava 2.
   Para verificar publicação, use o contador cumulativo ou espere a coleta.
2. **O papel do operador vem do banco a cada requisição, não do token.** Um token
   assinado com `role: viewer` sobre uma linha `operator` é autorizado como
   `operator` — que é o comportamento correto e documentado do `OpsAuthGuard`
   (revogar papel tem efeito na chamada seguinte). Testar a escada de permissão
   exige mudar a **linha**, não o token.

### O que a Entrega 6 mudou de rumo

- **O payload de webhook de pagamento não estava tão sanitizado quanto o nome
  sugeria.** `sanitizePayload` no ingest tira cartão e segredo, mas nome,
  e-mail, CPF/CNPJ e telefone do cliente continuavam íntegros. A leitura ganhou
  `maskPaymentPayload`, com a mesma regra das falhas: mascarado por padrão, em
  claro só para `canViewSensitive`, e cada visualização dessas gera linha de
  auditoria.
- **A trilha de auditoria é legível por qualquer operador ativo, de propósito.**
  Restringi-la a `ops_admin` faria com que só quem administra permissões pudesse
  conferir quem viu dado sensível. O que ficou com `ops_admin` é o detalhe com
  `beforeState`/`afterState`, que carrega o retrato do alvo.
- **O vocabulário dos filtros de auditoria vem das constantes, não de um
  `SELECT DISTINCT`.** Derivá-lo do banco faria uma ação sumir do filtro
  justamente enquanto ela nunca tivesse acontecido — que é quando procurá-la
  importa.

### Notas de ambiente

- `pnpm obs:check` valida configs do Alloy e regras de alerta (só precisa de Docker);
- `pnpm obs:up` sobe infra + Alloy + exporters localmente;
- em `apps/api/.env` e `apps/ai-agent/.env` (não versionados) foram adicionados
  `METRICS_TOKEN=local-dev-metrics-token` e `OPS_JWT_SECRET`; os `.env.example`
  documentam todas as variáveis novas;
- migrations aplicadas no banco local: `20260909230953_add_ops_identity_and_audit`
  (instala triggers que tornam `ops_audit_log` append-only de verdade — ele recusa
  `DELETE` inclusive para quem está limpando dado de teste) e
  `20260910202356_add_ops_failed_messages`;
- dependências novas: `prometheus-client` (agente), `@prometheus-io/client` e
  `@nestjs/terminus@^10` (API);
- no banco local há **2 operadores de teste desativados** (`github_user_id` 900001
  e 900002) e 1 linha em `ops_audit_log` que o trigger não deixou remover;
- **pnpm**: o `node_modules` foi instalado com 10.17.1 enquanto o `packageManager`
  diz 9.0.0. Para instalar dependência, use
  `node <caminho>/pnpm@10.17.1/.../pnpm.cjs --config.manage-package-manager-versions=false add ...`,
  senão o pnpm 9 recusa por store incompatível.
- **O `node_modules` do web estava incompleto** (Entrega 6): o pacote `next` não
  existia na store, e nada de frontend compilava. Restaurado com
  `node <pnpm 10>/pnpm.cjs --config.manage-package-manager-versions=false install --frozen-lockfile --filter @financial-vellun/web...`
  — o lockfile já tinha `next@14.2.35`, então nada nele mudou.
- no banco local, `ops_audit_log` tem **20 linhas** de verificação manual das
  Entregas 5 a 7, que o trigger não deixa remover — é a garantia funcionando;
- **Não rode `pnpm format` no repositório inteiro.** O código em `main` nunca foi
  formatado com a config atual: um `pnpm format` reescreve ~82 arquivos que não
  têm relação nenhuma com a mudança em curso. Formate só o que você tocou
  (`pnpm exec prettier --write <arquivos>`) até alguém decidir formatar tudo num
  commit próprio.

---

## Arquitetura

```
                          ┌──────────────────────────────────────────┐
  GitHub OAuth ──────────►│ identidade dos operadores (org + 2FA)    │
  (org VellunSolutioins)  └──────────────────────────────────────────┘
                                    │                    │
                                    ▼                    ▼
  Vercel                    ┌───────────────┐    ┌────────────────┐
  ┌──────────────┐          │ painel /ops   │    │ Grafana Cloud  │
  │ web (Next)   │─────────►│ (mesma app)   │    │ métricas, logs │
  └──────────────┘          └───────┬───────┘    │ alertas        │
                                    │            └────────▲───────┘
  Railway (rede privada)            ▼                     │ remote_write
  ┌─────────────────────────────────────────────┐         │ + push
  │ api (NestJS)  ── /metrics, /health/*        │         │
  │ ai-agent-web  ── /metrics, /health/*        │◄────────┤ scrape (rede privada)
  │ ai-agent-worker ── /metrics, /health/*      │    ┌────┴────┐
  │ postgres · redis · rabbitmq                 │    │  Alloy  │
  │ exporters: postgres, redis, rabbitmq(15692) │    └────┬────┘
  └─────────────────────────────────────────────┘         │
                    Railway log drain (HTTP) ─────────────┘
```

**Fonte de verdade por estado** — isto é o contrato central e precisa ficar explícito:

| Estado                                  | Fonte de verdade                     | Observação                                         |
| --------------------------------------- | ------------------------------------ | -------------------------------------------------- |
| Mensagem em processamento normal        | RabbitMQ                             | filas `whatsapp.*.v1`                              |
| **Mensagem que falhou definitivamente** | **Postgres (`ops_failed_messages`)** | a DLQ vira transporte, não armazém — ver Entrega 5 |
| Evento de webhook de pagamento          | Postgres (`payment_webhook_events`)  | já é assim                                         |
| Métricas e logs                         | Grafana Cloud                        | retenção do free tier                              |
| Trilha de ações do operador             | Postgres (`ops_audit_log`)           | append-only                                        |

---

## Entregas

Cada uma funciona e é verificável sozinha. As dependências estão marcadas.

### Entrega 0 — Identidade e autorização de operações ✅

Pré-requisito de tudo. Sem isso não há como restringir acesso nem auditar.

**Modelo** (`apps/api/prisma/schema.prisma` + migration):

- `ops_operators` — `id`, `githubLogin @unique`, `githubUserId @unique`, `name`, `email`, `role`
  (`viewer` | `operator` | `ops_admin`), `canViewSensitive Boolean @default(false)`, `active`,
  `createdAt`, `lastLoginAt`. **Tabela separada de `users` por construção**: nenhum cliente vira
  operador por ser admin de uma conta do produto, porque não há caminho de código entre as duas.
- `ops_audit_log` — `id`, `operatorId`, `action`, `targetType`, `targetId`, `reason?`, `result`,
  `operationId`, `beforeState Json?`, `afterState Json?`, `createdAt`. Append-only: sem `update`
  nem `delete` no service, e o usuário de banco da aplicação não recebe `DELETE` nessa tabela.

**Backend** (`apps/api/src/ops/auth/`):

- Fluxo OAuth: `GET /ops/auth/github` → `GET /ops/auth/github/callback`. No callback, verificar
  **pertencimento à org** via API do GitHub; recusar quem não pertence. Fazer upsert em
  `ops_operators` (primeiro login entra como `viewer` e inativo, um `ops_admin` promove).
- Sessão **separada da do produto**: cookie `ops_session`, segredo `OPS_JWT_SECRET` distinto,
  TTL curto (30 min) com renovação. Um `access_token` de cliente nunca é aceito, e vice-versa.
- `OpsAuthGuard` + `@OpsRoles('operator','ops_admin')` + `OpsRolesGuard`, seguindo o formato do
  `ActiveSubscriptionGuard` já existente (`apps/api/src/billing/guards/`).
- **Correção obrigatória em `apps/api/src/common/guards/csrf.guard.ts`**: hoje o guard retorna `true`
  quando não há `access_token` nem `refresh_token` no cookie. Com um cookie novo `ops_session`, todos
  os POST de operações passariam **sem verificação de CSRF**. O `hasSession` precisa incluir o cookie
  de ops. Já existe teste do guard em `csrf.guard.spec.ts` para estender.

**Frontend** (`apps/web/src/app/ops/`): layout próprio, tela de login que só redireciona ao GitHub,
e um `ops-api-client` separado do `apps/web/src/lib/api-client.ts` — o cliente atual redireciona
para `/app/conta/assinatura` em `403 SUBSCRIPTION_REQUIRED` globalmente, comportamento que a área de
operações não pode herdar.

**Critério de aceite**: usuário comum autenticado no produto recebe `403` em toda rota `/ops/*`;
`viewer` recebe `403` ao tentar reprocessar; quem não é da org não completa o login; toda ação
sensível grava linha em `ops_audit_log` com o `operatorId`.

---

### Entrega 1 — Instrumentação (métricas, health, logs estruturados) ✅

Independe da Entrega 0 e pode andar em paralelo.

**API NestJS** (`apps/api/src/observability/`), dependências novas: `prom-client`, `@nestjs/terminus`.

- `/metrics` em formato Prometheus, protegido por `Authorization: Bearer ${METRICS_TOKEN}`.
- `MetricsInterceptor` com `http_requests_total{method,route,status}` e
  `http_request_duration_seconds` (histograma). **Rota normalizada** a partir do path pattern do Nest
  (`/transactions/:id`), nunca o path concreto.
- `CorrelationIdMiddleware` com `AsyncLocalStorage`: aceita `x-correlation-id` de entrada ou gera um,
  ecoa na resposta, e propaga para o `/internal/*` (o agente já gera e propaga o seu —
  `apps/ai-agent/src/observability/logging.py`).
- `LoggerService` JSON estruturado + `AllExceptionsFilter` global. Campos: `timestamp`, `level`,
  `service`, `env`, `event`, `correlationId`, `errorType`. **Sanitização também nas exceções.**
- `/health/live` (só o processo) e `/health/ready` (Prisma + RabbitMQ quando aplicável), com timeout
  curto. Manter `GET /` como está, por compatibilidade.

**Agente Python** — migração compatível, importante porque há consumidores reais:

- `/metrics` passa a devolver formato Prometheus (`prometheus_client`).
- `/metrics.json` preserva o shape atual, e `apps/ai-agent/scripts/monitor.py` e `loadtest.py`
  passam a apontar para ele. Documentar a migração no runbook.
- **O worker não tem servidor HTTP.** `apps/ai-agent/src/worker.py` precisa subir um servidor mínimo
  expondo `/metrics` e `/health/*`, senão as réplicas de consumo ficam invisíveis — que é justamente
  onde o trabalho acontece.
- Converter os contadores de `apps/ai-agent/src/services/metrics.py` para `Counter`/`Histogram`,
  com nomes e unidades consistentes (`_total`, `_seconds`).

**Regra de cardinalidade, válida para os dois serviços**: `correlationId`, `jobId`, telefone, e-mail
e conteúdo de mensagem **nunca** viram label. Eles vão para o log, e o log é a ponte.

**Critério de aceite**: `curl` autenticado em `/metrics` dos três serviços devolve texto Prometheus
válido; `/health/ready` da API responde `503` com o Postgres derrubado enquanto `/health/live`
continua `200`; um request com `x-correlation-id` aparece nos logs da API e do agente com o mesmo id.

---

### Entrega 2 — Coleta (Alloy no Railway → Grafana Cloud) ✅

Depende da Entrega 1.

- `infra/observability/alloy/config.alloy` versionado: scrape dos três serviços pela rede privada do
  Railway, `remote_write` para o Prometheus do Grafana Cloud, e `loki.source.api` recebendo o **log
  drain HTTP do Railway** — que é o caminho que evita depender de ler stdout de outro container.
- Exporters como serviços pequenos no mesmo projeto: `postgres_exporter`, `redis_exporter`, e o
  plugin `rabbitmq_prometheus` (porta 15692) habilitado no RabbitMQ.
- Contas de monitoramento com privilégio mínimo: usuário Postgres somente-leitura em
  `pg_stat_*`, usuário RabbitMQ com tag `monitoring`.
- Segredos (`GRAFANA_CLOUD_*`, `METRICS_TOKEN`) nas variáveis do Railway, nunca no repo.

**Confirmar na documentação oficial no momento da implementação**: versões de imagem do Alloy e dos
exporters, e os limites correntes do free tier do Grafana Cloud (séries ativas, GB de log, retenção)
— esses números mudam e não devem ser fixados de memória no plano.

**Critério de aceite**: `up{job="api"}`, `up{job="ai-agent"}` e `up{job="ai-agent-worker"}` valendo
1 no Grafana Cloud; uma consulta Loki filtrando por `correlationId` traz a linha correspondente.

---

### Entrega 3 — Dashboards e alertas ✅

Depende da Entrega 2. Tudo em arquivo versionado, provisionado, não clicado na UI.

`infra/observability/dashboards/`: `overview.json`, `whatsapp-pipeline.json`, `api.json`,
`payments.json`. `infra/observability/alerts/`: regras Grafana em YAML.

Alertas: indisponibilidade persistente; fila com mensagem e **zero consumidores**; backlog crescendo
de forma sustentada; **nova entrada em DLQ**; acúmulo persistente na DLQ; erro ou latência subindo;
falha definitiva de pagamento; pressão de memória e disco; **ausência inesperada de dados** (`up == 0`
ou `absent()`).

Cada alerta carrega resumo, serviço, ambiente, link do dashboard e link do procedimento no
`docs/whatsapp-messaging-runbook.md`.

**Canais de notificação ficam declarados mas sem destino configurado.** Nada é enviado para fora
durante a implementação.

**Critério de aceite**: derrubar o consumidor em ambiente isolado dispara "fila sem consumidor";
forçar uma mensagem para a DLQ dispara "nova entrada em DLQ". Ambos verificados no estado _Pending →
Firing_ do Grafana, sem envio externo.

---

### Entrega 4 — RabbitMQ Management como ponte ✅

Documental, sem código. Estende `docs/whatsapp-messaging-runbook.md` com: verificar filas e
consumidores, identificar mensagens na DLQ, interpretar o envelope (`DlqEnvelopeV1` —
`apps/ai-agent/src/messaging/contracts.py`), investigar a causa **antes** de reprocessar, republicar
o payload original, confirmar o resultado.

Deixar explícito que **"Get messages" é uma operação sobre a fila**: mesmo com `requeue = Yes` ela
entrega a mensagem ao cliente e a devolve ao fim, podendo alterar ordem e afetar entrega. Não é
`SELECT`. E **purge não é procedimento de recuperação** — descarta sem registro.

---

### Entrega 5 — Catálogo de falhas (a decisão arquitetural) ✅

Depende da Entrega 0.

O pedido exige resolver isto explicitamente, então: **RabbitMQ não oferece navegação arbitrária,
paginação nem filtro.** Ler a DLQ sob demanda para montar a tela transformaria cada abertura de
página em consumo e republicação da fila — exatamente o que não pode acontecer.

**Decisão: catálogo persistente em Postgres.** Um consumer dedicado
(`apps/ai-agent/src/consumers/dlq_catalog_consumer.py`) consome `whatsapp.inbound.dlq` e
`whatsapp.processing.dlq`, grava em `ops_failed_messages` e só então acka. A partir daí:

- **A DLQ é transporte; o Postgres é a fonte de verdade** do que falhou.
- Filtro, paginação e ordenação passam a ser possíveis de verdade — sem prometer o que a fila não
  entrega.
- Se o consumer do catálogo cair, as mensagens **se acumulam na DLQ** (nada se perde) e o alerta de
  profundidade de DLQ dispara. A profundidade da fila e a contagem do catálogo viram um par que o
  dashboard compara para expor divergência.

`ops_failed_messages`: `id`, `source` (`whatsapp_inbound` | `whatsapp_processing`), `sourceQueue`,
`routingKey`, `correlationId`, `providerMessageId?`, `jobId?`, `phoneHash`, `errorType`,
`errorMessage`, `attempts`, `permanent`, `payload Json`, `status` (`pending` | `reprocessing` |
`reprocessed` | `discarded`), `firstFailedAt`, `capturedAt`, `retentionUntil`. Índices por
`status`, `capturedAt`, `correlationId`.

**Dados sensíveis**: o payload precisa ficar íntegro para permitir reprocessamento, mas o telefone é
gravado **apenas como hash** e a leitura pela API é **mascarada por padrão**. O conteúdo em claro só
é devolvido a operador com `canViewSensitive`, e **cada visualização dessas gera linha de auditoria**.

**Retenção**: `retentionUntil` com expurgo por cron; itens `reprocessed` saem antes dos `pending`.

**Critério de aceite**: mensagem forçada à DLQ aparece no catálogo em segundos; a listagem filtra por
fila, período, tipo de erro e `correlationId`; abrir a página cem vezes não consome nada da fila;
telefone aparece mascarado para `operator` sem a permissão.

---

### Entrega 6 — Painel de operações ✅

Depende das Entregas 0 e 5.

**Backend** (`apps/api/src/ops/`): `overview`, `failures` (listar/detalhar), `payments`, `audit`.
Toda conversa com RabbitMQ e banco passa por aqui — o navegador nunca fala com o broker.

**Frontend** (`apps/web/src/app/ops/`): resumo com links para o Grafana, lista e detalhe de falhas,
filtros, diagnóstico sanitizado, link para os logs correlacionados, histórico de ações.

Dois atalhos que o diagnóstico do frontend apontou e que valem antes de começar: **não existe
componente de tabela nem de paginação** — o padrão está duplicado em quatro arquivos
(`apps/web/src/app/app/pessoal/lancamentos/page.tsx:176` e os três `components/*/View.tsx`). Extrair
`components/ui/table.tsx` e `components/ui/pagination.tsx` a partir desse padrão serve ao painel e
paga dívida existente. Seguir o idioma "página fina + view parametrizada" de `ContactsView`.

Usar **apenas tokens de cor** (`bg-background`, `bg-card`, `text-muted-foreground`): o dark mode está
configurado em `tailwind.config.ts` mas é inutilizável porque o app inteiro usa `bg-white`/`bg-gray-50`
hard-coded. O painel novo não deve aprofundar essa dívida.

---

### Entrega 7 — Reprocessamento e auditoria ✅

Depende da Entrega 6. **Antes de implementar, há um furo de deduplicação a corrigir** (ver Achados).

- Destino validado contra **allowlist no servidor** — exchange e routing key nunca vêm do navegador.
- Publicação com _publisher confirm_, reaproveitando `MessagePublisher`
  (`apps/ai-agent/src/messaging/base.py`).
- A linha do catálogo é marcada `reprocessing` → publica → `reprocessed`. **Não há atomicidade entre
  publicar e marcar**, e o plano não vai fingir que há: uma falha no meio deixa a linha em
  `reprocessing`, e um cron a reconcilia após um limite de tempo. A idempotência do pipeline
  (`jobId`, `providerMessageId`, `idempotencyKey`) é o que impede efeito duplicado.
- Estados distintos e visíveis: **solicitação aceita** ≠ **mensagem republicada** ≠ **processamento
  concluído** ≠ **nova falha**.
- Lotes: tamanho e concorrência limitados, resultado por item, itens já tratados são pulados,
  interrupção diante de falha sistêmica.

Auditoria em `ops_audit_log`: operador, data/hora, ação, alvo, justificativa, resultado, id da
operação, estado anterior e posterior. Sem payload sensível completo.

---

### Entrega 8 — Webhooks de pagamento: durabilidade e recuperação 🔜 próxima

Você aprovou corrigir antes de construir a recuperação, e o motivo é concreto: hoje o retry vive em
`setTimeout` no processo (`apps/api/src/billing/webhook/webhook.processor.ts:39-63`, 5 tentativas,
backoff `2^n * 500ms`, ~7,5s no total). Um deploy dentro dessa janela perde o evento. E
`markFailed` grava `status = failed` **a cada** falha, antes de decidir se haverá retry — então o
painel não conseguiria distinguir "vai ser retentado sozinho" de "acabou", e o operador
reprocessaria por cima de um retry em andamento.

- Schema: `nextRetryAt`, `attemptedAt`, e separar `failed` (transitório, retry pendente) de
  `exhausted` (definitivo). Índice por `status, nextRetryAt`.
- Cron de varredura retoma eventos com `nextRetryAt` vencido — é o que dá durabilidade sem
  introduzir fila nova. Seguir o formato do `ReconciliationService` (`@Cron`, batch, guarda de
  reentrância).
- Testar `enqueue`/`runWithRetry`/backoff, que hoje **não têm nenhum teste** (o spec cobre só
  `process()`).
- Recuperação pelo painel só para `exhausted`. Risco de efeito externo duplicado analisado à parte:
  `process()` já sai cedo se `processed`, e `handleSuccess` confirma no PSP antes de conceder acesso
  — mas **mudar status no banco não é reprocessar**, e a identidade do evento (`providerEventId`) é
  preservada.

---

### Entrega 9 — Rastreamento distribuído ⏸️ fora desta leva

Só depois que métricas, logs e operação estiverem estáveis. OpenTelemetry na API e no agente,
exportando para o Tempo do Grafana Cloud. Propagação de contexto que sobreviva a retry e ao
agrupamento — onde a relação pai/filho não descreve o fluxo (várias mensagens viram um job), usar
**links entre spans**, não um pai artificial. Amostragem e retenção definidas; falha de exportação
nunca interrompe a aplicação.

---

## Achados que precisam de correção

Encontrados no diagnóstico, listados aqui porque bloqueiam entregas específicas.

1. **Deduplicação do inbound engole mensagem no retry** — bloqueia a Entrega 7.
   `apps/ai-agent/src/consumers/inbound_consumer.py:_handle_text` persiste a `AiMessage` e depois
   grava no agrupamento. Se a segunda etapa falhar (Redis fora), o retry encontra a mensagem como
   duplicata, retorna cedo e **acka sem agrupar** — a mensagem se perde silenciosamente. O mesmo
   caminho torna o reprocessamento manual um no-op. A correção é o agrupamento aceitar a duplicata
   reaproveitando o id já persistido, com deduplicação por `providerMessageId` dentro do grupo.
2. **CSRF cego para a sessão de ops** — bloqueia a Entrega 0. Detalhado acima.
3. **`/internal/*` sem identidade de chamador** — chave única compartilhada entre API e agente, sem
   rotação e sem escopo. Não bloqueia nada agora, mas qualquer ação disparada por ali é inauditável.
   Registrar como dívida, não corrigir nesta leva.
4. **`payment_webhook_events` é uma ilha** — sem relação com `Subscription`/`User`/`Payment` e sem
   índice por data. Uma tela "falhas recentes" ordenada por data faz varredura completa.

---

## Verificação

Ambiente isolado para tudo que consuma mensagem ou provoque falha. **Nenhum reprocessamento real de
produção durante a validação.**

```bash
# Infra local
pnpm db:up

# Instrumentação
curl -H "Authorization: Bearer $METRICS_TOKEN" localhost:3001/metrics   # texto Prometheus
curl localhost:3001/health/live && curl localhost:3001/health/ready
docker stop financial-vellun-db && curl -i localhost:3001/health/ready  # 503, live segue 200

# Pipeline sob carga, com o catálogo ligado (scripts já existentes)
cd apps/ai-agent && .venv/Scripts/python.exe scripts/loadtest.py --total 300 --wait-drain 90
.venv/Scripts/python.exe scripts/monitor.py --interval 1

# Testes
pnpm --filter @financial-vellun/api test
cd apps/ai-agent && .venv/Scripts/python.exe -m pytest -q
cd apps/ai-agent && .venv/Scripts/python.exe -m pytest -m integration -q
```

Casos que precisam de teste automatizado, além dos acima:

- usuário comum do produto recebe `403` em `/ops/*`; `viewer` não reprocessa; `operator` não descarta;
- nenhuma resposta de `/ops/*` contém segredo, token ou telefone completo sem a permissão específica;
- readiness refletindo dependência caída, sem derrubar liveness;
- mensagem inválida (contrato) vs. mensagem com tentativas esgotadas — destinos diferentes;
- reprocessamento após corrigir a causa conclui de fato, e o estado no painel evolui pelos quatro
  estágios distintos;
- reprocessar duas vezes o mesmo item não cria dois lançamentos (validar contra a idempotência real
  já existente: `jobId`, `providerMessageId`, `idempotencyKey`);
- falha entre publicar e marcar deixa a linha reconciliável, não perdida;
- toda ação de operador gera linha de auditoria, e um `operator` não consegue alterá-la.

---

## Riscos e pendências

- **Não existe deploy versionado para API e agente.** O Railway é operado pelo painel, então nada
  disso está no repositório e não há como revisar mudança de infraestrutura em PR. Esta é a maior
  fragilidade do conjunto e vale endereçar em trabalho próprio (Dockerfile da API, `.dockerignore`,
  e configuração declarativa).
- **Não há ambiente de staging.** "Ambiente isolado para validação" hoje significa a máquina local.
  Alertas e reprocessamento serão exercitados localmente até existir staging.
- **Free tier do Grafana Cloud tem teto.** Cardinalidade descuidada estoura o limite de séries e a
  conta passa a cobrar ou a descartar. Por isso a regra de labels é parte da Entrega 1, não um
  detalhe posterior.
- **`ops.<domínio>` depende de domínio próprio**, que ainda não existe (só `*.vercel.app`). Até lá o
  painel vive em `/ops` na app atual, com rewrite para o subdomínio quando houver domínio.
- **SSO não cobre o RabbitMQ Management.** GitHub OAuth resolve painel e Grafana Cloud; o Management
  fica com usuário próprio de privilégio mínimo e acesso restrito por rede. Colocar um oauth2-proxy
  na frente é possível, mas é mais um serviço no Railway — proposto só se o acesso direto incomodar.
- **Sanitizar não é reversível.** `sanitizePayload`
  (`apps/api/src/billing/webhook/webhook-event.service.ts:7-27`) redige campos sensíveis antes de
  persistir, e o reprocessamento lê exatamente esse payload redigido. Se algum campo redigido for
  necessário para reprocessar, a recuperação daquele evento é impossível sem consultar o PSP.
- **Estimativa de recursos e política de retenção** serão fechadas na Entrega 2, depois de medir a
  cardinalidade real — estimar antes disso seria chute.
