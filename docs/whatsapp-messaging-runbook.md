# Runbook — pipeline de mensageria do WhatsApp

Operação do fluxo `webhook → whatsapp.inbound.v1 → agrupamento → whatsapp.processing.v1 → lançamento`.
As decisões por trás do desenho estão em [docs/adrs/](adrs/README.md); a visão
geral e as variáveis de ambiente estão no [README](../README.md).

---

## Mapa rápido

| Recurso               | Nome                                                   | Papel                                           |
| --------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| Exchange principal    | `whatsapp.x`                                           | routing keys `inbound` e `processing`           |
| Exchange de retry     | `whatsapp.retry.x`                                     | recebe as republicações com atraso              |
| Dead-letter exchange  | `whatsapp.dlx`                                         | routing keys `inbound.dlq` e `processing.dlq`   |
| Fila de entrada       | `whatsapp.inbound.v1`                                  | mensagens individuais do webhook                |
| Fila de processamento | `whatsapp.processing.v1`                               | jobs consolidados por telefone                  |
| Retry                 | `whatsapp.{inbound,processing}.retry.{1,4,16,60,300}s` | TTL fixo, dead-letter de volta à fila de origem |
| DLQ                   | `whatsapp.{inbound,processing}.dlq`                    | falhas permanentes ou tentativas esgotadas      |

Chaves no Redis:

| Chave                 | Papel                                   | TTL                              |
| --------------------- | --------------------------------------- | -------------------------------- |
| `group:{phone}`       | mensagens aguardando consolidação       | — (removida no flush)            |
| `group:first:{phone}` | epoch da primeira mensagem do grupo     | —                                |
| `group:due`           | sorted-set com o vencimento do debounce | —                                |
| `group:lock:{phone}`  | lock da consolidação                    | `REDIS_LOCK_TTL_SECONDS`         |
| `proc:lock:{phone}`   | lock do processamento                   | `PROCESSING_LOCK_TTL_SECONDS`    |
| `job:done:{jobId}`    | job já concluído (deduplicação)         | `JOB_DEDUPE_TTL_SECONDS`         |
| `conv:{phone}`        | confirmação pendente                    | `CONVERSATION_STATE_TTL_SECONDS` |

---

## Saúde

```bash
curl http://localhost:8010/health/live    # o processo está de pé
curl http://localhost:8010/health/ready   # consegue publicar e consumir

# Métricas: exigem Bearer quando METRICS_TOKEN está definido
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:8010/metrics       # Prometheus
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:8010/metrics.json  # {counters, timings}

# O worker (`python -m src.worker`) expõe o mesmo em WORKER_METRICS_PORT
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:8011/metrics
curl http://localhost:8011/health/ready

# A API principal também
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3001/metrics
curl http://localhost:3001/health/live && curl http://localhost:3001/health/ready
```

`/health/ready` responde `503` quando o broker ou o Redis estão fora. É o
endpoint que o orquestrador deve usar para tirar a instância do balanceador —
uma instância que não pode publicar não deve receber webhooks. Use
`/health/live` para a decisão de reiniciar.

Na API principal a distinção é a mesma: `/health/ready` responde `503` com o
Postgres fora, enquanto `/health/live` segue `200`. Reiniciar a API não conserta
um banco caído, então liveness não pode depender dele. `GET /` continua
respondendo `{"status":"ok"}` por compatibilidade — **não use para readiness**:
ele responde `ok` com o banco fora, que é exatamente o que motivou os endpoints
novos.

> **O worker precisa ter porta.** Ele não servia HTTP, então as réplicas de
> consumo eram invisíveis para o scrape — justamente onde o trabalho acontece. É
> o par que o alerta "fila com mensagem e zero consumidores" compara.

Resposta saudável:

```json
{ "status": "ok", "pipeline": "broker", "broker": "up", "consumers": "up", "redis": "up" }
```

`consumers: "disabled"` é esperado quando `RUN_CONSUMERS_IN_API=false` (a
instância só publica).

---

## Métricas e o que elas indicam

### Formato: `/metrics` mudou, `/metrics.json` preserva o antigo

`GET /metrics` devolve **texto Prometheus**; o shape antigo (`{counters,
timings}`) vive em `GET /metrics.json`. A separação existe porque o formato
antigo tem consumidores reais — `scripts/monitor.py` e `scripts/loadtest.py` —, e
trocar o formato sem deixar o antigo em algum lugar quebraria as duas ferramentas
usadas justamente para validar carga.

Os nomes seguem a convenção do Prometheus, então a tabela abaixo (que usa os
nomes internos) mapeia assim:

- contador `messages_consumed` → `vellun_agent_messages_consumed_total`;
- latência `llm_latency_ms` → histograma `vellun_agent_llm_latency_seconds`
  (**em segundos**, não em milissegundos — o `/metrics.json` continua reportando
  a média em ms).

Os contadores são **declarados na inicialização**, e não criados na primeira
ocorrência. Isso importa para alerta: uma série que só nasce quando o evento
acontece faz `rate(...)` e `absent(...)` responderem "sem dado" em vez de "zero",
e é impossível alertar sobre algo que nunca apareceu. Com a declaração, "nenhuma
mensagem na DLQ hoje" é um zero legítimo.

**Regra de cardinalidade:** `correlationId`, `jobId`, telefone, e-mail e conteúdo
de mensagem nunca viram label — vão para o log, e o log é a ponte. Um label livre
cria uma série por valor distinto e estoura o limite de séries ativas do free
tier, e aí a conta passa a cobrar ou a descartar dado em silêncio. O que varia
por categoria (tipo de mídia, por exemplo) vira **nome** de métrica.

Na API principal, `route` é sempre o padrão da rota (`/transactions/:id`), nunca
o path concreto, e requisição que não casa com rota nenhuma é agrupada em
`route="unmatched"` — sem isso, uma varredura de vulnerabilidade criaria uma
série por URL tentada.

### O que cada uma indica

| Métrica                                                | Leitura                                                                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `webhook_received` / `publish_confirmed`               | divergência entre os dois indica mensagens descartadas antes de publicar (longas demais, ou payload sem mensagem) |
| `publish_failed`                                       | o webhook devolveu `503`; o provedor vai reenviar                                                                 |
| `webhook_latency_ms`                                   | inclui o _publisher confirm_. Subida sustentada = broker sob pressão                                              |
| `messages_consumed` / `messages_duplicated`            | duplicadas altas são normais após um reenvio da Meta; sustentadas indicam ack lento                               |
| `inbound_grouped` / `group_flushed` / `jobs_published` | acompanham o funil de consolidação                                                                                |
| `receive_to_process_ms`                                | tempo entre receber e começar a processar; inclui o debounce (5 s)                                                |
| `processing_duration_ms`                               | duração do processamento; dominado pela latência do LLM                                                           |
| `jobs_deferred`                                        | jobs adiados por lock de telefone. Alto = muita mensagem simultânea do mesmo número                               |
| `jobs_duplicated`                                      | reentregas descartadas pelo marcador `job:done`                                                                   |
| `transactions_created` / `transactions_idempotent_hit` | lançamentos criados e lançamentos devolvidos por idempotência                                                     |
| `transaction_failed`                                   | a API recusou o lançamento (conta/categoria inválida, sem assinatura)                                             |
| `whatsapp_send_failed`                                 | falha ao responder ao usuário                                                                                     |
| `dlq` / `dlq_messages`                                 | qualquer valor diferente de zero pede investigação                                                                |

Todo log relacionado ao mesmo evento carrega `correlationId`,
`providerMessageId`, `jobId` (quando aplicável) e o telefone **hasheado** em
produção (mascarado em desenvolvimento). Nunca o número completo.

### Seguindo um evento pelos dois serviços

O `correlationId` atravessa API e agente. Quem manda o header `x-correlation-id`
tem o id respeitado (validado antes: quebra de linha e caractere fora de
`[A-Za-z0-9._:-]` são recusados, para não injetar linha falsa num log
estruturado); quem não manda recebe um gerado. O id volta na resposta, nos dois
serviços, então dá para copiar da resposta e consultar direto:

```bash
# Um fluxo inteiro sob o mesmo id
curl -X POST http://localhost:8010/webhook/whatsapp \
  -H 'Content-Type: application/json' \
  -H 'x-correlation-id: investigacao-1' \
  -d '{"phone":"+5541999999999","message":"gastei 10","message_id":"wamid.x"}'
```

No Loki, `{service="api"} |= "investigacao-1"` e `{service="ai-agent"} |=
"investigacao-1"` trazem as duas metades do mesmo fluxo. Em produção o log da API
é uma linha JSON por evento (`timestamp`, `level`, `service`, `env`, `event`,
`correlationId`, `errorType`); em desenvolvimento é texto legível, porque JSON num
terminal ninguém depura.

---

## Teste de carga

Dois scripts em `apps/ai-agent/scripts/`. O `loadtest.py` dispara e mede a
latência **do lado do cliente**; o `monitor.py` acompanha o pipeline em um
segundo terminal.

> **Antes de rodar:** com os consumers ligados, cada mensagem processada vira
> uma resposta ao usuário. Use `WHATSAPP_PROVIDER=log`, ou a carga vira centenas
> de chamadas reais à API da Meta.

```bash
cd apps/ai-agent

# 500 requests, 50 em paralelo, espalhados por 50 telefones,
# esperando o pipeline drenar e com veredito no fim
.venv/Scripts/python.exe scripts/loadtest.py --total 500 --concurrency 50 --wait-drain 120

# contenção proposital: tudo no mesmo telefone (exercita o lock e o defer)
.venv/Scripts/python.exe scripts/loadtest.py --total 200 --phones 1 --wait-drain 60

# payload real da Meta, 5 mensagens por request
.venv/Scripts/python.exe scripts/loadtest.py --total 100 --batch 5

# em outro terminal, ao vivo
.venv/Scripts/python.exe scripts/monitor.py --interval 1

# com METRICS_TOKEN definido, os scripts precisam do token (ou leem do ambiente)
.venv/Scripts/python.exe scripts/monitor.py --token "$METRICS_TOKEN"

# com RUN_CONSUMERS_IN_API=false, aponte para a porta do worker: é quem consome
.venv/Scripts/python.exe scripts/monitor.py --metrics http://localhost:8011/metrics.json
```

O veredito confere o que importa: todos os requests aceitos com `202`, nenhum
`503`, contadores batendo, filas **e** grupos do Redis drenados, todos os jobs
processados e DLQ vazia. Sai com código 1 se algo falhar, então serve em CI.

### Números de referência

Medidos nesta máquina (Windows, Docker Desktop, um processo uvicorn,
`RUN_CONSUMERS_IN_API=false`, 400 requests por rodada):

| Concorrência | Throughput | p50     | p95     | p99     |
| ------------ | ---------- | ------- | ------- | ------- |
| 5            | 476 req/s  | 9,8 ms  | 14,1 ms | 16,3 ms |
| 10           | 594 req/s  | 15,8 ms | 21,2 ms | 32,1 ms |
| 25           | 575 req/s  | 33,7 ms | 95,4 ms | 127 ms  |
| 50           | 486 req/s  | 71,1 ms | 259 ms  | 382 ms  |

O joelho fica entre 10 e 25 requests simultâneos: acima disso o throughput para
de crescer e a latência sobe, porque as publicações disputam o mesmo canal
AMQP à espera do _publisher confirm_. Para mais vazão, escale em processos
(réplicas da API) em vez de empilhar concorrência num só.

Duas leituras que confundem se você não souber:

- **`webhook_latency_ms` do `/metrics` é sempre menor que o p50 do cliente.** A
  métrica mede só o tempo dentro do handler; o cliente mede também a espera na
  fila do event loop. Sob concorrência alta a diferença chega a 5x — é o
  esperado, não é erro de medição.
- **Fila vazia não é pipeline drenado.** Mensagem consumida vai para o buffer de
  agrupamento no Redis e só vira job quando o debounce vence. Por isso o
  `--wait-drain` também olha `ZCARD group:due` e compara
  `jobs_published`/`jobs_processed`.

---

## Backlog crescendo

```bash
docker exec financial-vellun-rabbitmq rabbitmqctl list_queues name messages consumers
```

1. Confirme que há consumers ligados (`consumers > 0`). Zero = o processo do
   worker não subiu ou perdeu a conexão; veja `/health/ready`.
2. Se houver consumers e a fila cresce, aumente
   `PROCESSING_CONSUMER_CONCURRENCY` ou suba mais réplicas de
   `python -m src.worker`.
3. Se `whatsapp.processing.v1` cresce e `jobs_deferred` está alto, o gargalo é
   contenção por telefone — mais réplicas não ajudam; investigue por que um
   telefone está preso (`proc:lock:*` no Redis).

---

## Mensagens na DLQ

```bash
# Quantas
docker exec financial-vellun-rabbitmq rabbitmqctl list_queues name messages \
  | grep dlq

# Inspecionar sem consumir: painel → Queues → whatsapp.processing.dlq → Get messages
# (requeue = Yes, para não remover)
```

O envelope traz o necessário para o diagnóstico:

```json
{
  "schemaVersion": 1,
  "payload": { "...mensagem original..." },
  "sourceQueue": "whatsapp.processing.v1",
  "routingKey": "processing",
  "attempts": 5,
  "errorType": "ConnectionError",
  "errorMessage": "…truncado em 500 caracteres…",
  "permanent": false,
  "failedAt": "2026-09-05T18:00:00Z",
  "correlationId": "…"
}
```

- `permanent: true` → contrato inválido ou tipo não suportado. Reprocessar não
  resolve; corrija a origem.
- `permanent: false` → as tentativas se esgotaram. Resolva a causa (API fora,
  OpenAI indisponível) e então reprocesse.

### Reprocessar

Não existe botão de "shovel" configurado. O caminho é republicar o `payload` na
exchange principal com a routing key de origem, depois de resolver a causa:

```bash
# 1. Confirme que a causa foi resolvida
curl http://localhost:8010/health/ready

# 2. Painel do RabbitMQ → Exchanges → whatsapp.x → Publish message
#    Routing key: inbound   (ou processing)
#    Payload: o conteúdo do campo `payload` do envelope
#    Properties: delivery_mode = 2
```

Reprocessar é seguro: os três níveis de idempotência
([ADR 0005](adrs/0005-idempotencia-em-tres-niveis.md)) impedem `AiMessage`
duplicada, job duplicado e lançamento duplicado.

Depois de republicar, remova a mensagem da DLQ (Get messages com
`requeue = No`, ou `Purge` se você já republicou todas).

---

## Webhook devolvendo 503

Significa que o broker não confirmou a publicação. A Meta vai reenviar, então
não há perda — mas o relógio de reenvio dela é curto.

```bash
docker compose -f infra/docker/docker-compose.yml ps rabbitmq
docker logs financial-vellun-rabbitmq --tail 50
curl http://localhost:8010/health/ready
```

A conexão reconecta sozinha (`connect_robust`); assim que o broker volta, o
`readiness` fica verde e os `202` voltam.

---

## Confirmações pendentes travadas

Um usuário que recebeu "Confirma o lançamento?" e não responde fica com estado
por `CONVERSATION_STATE_TTL_SECONDS` (30 min).

```bash
# Ver o estado de um telefone
docker exec financial-vellun-redis redis-cli GET "conv:+5541999999999"

# Limpar (o usuário recomeça o lançamento do zero)
docker exec financial-vellun-redis redis-cli DEL "conv:+5541999999999"
```

## Lock de telefone preso

```bash
docker exec financial-vellun-redis redis-cli KEYS "proc:lock:*"
docker exec financial-vellun-redis redis-cli TTL "proc:lock:+5541999999999"
```

O lock tem TTL, então se resolve sozinho. Se um telefone fica preso além do
TTL, há um worker travado no processamento — reinicie o worker. Jobs adiados
mais de 60 vezes deixam de ser adiados e caminham para a DLQ, por desenho
([ADR 0004](adrs/0004-ordenacao-por-lock-por-telefone.md)).

---

## Deploy

O shutdown é gracioso: o worker de agrupamento para, os consumers cancelam o
consumo, aguardam o que está em voo até `SHUTDOWN_DRAIN_SECONDS` e devolvem à
fila o que não terminou. Mensagens confirmadas não se perdem.

Dê ao orquestrador um `terminationGracePeriod` maior que
`SHUTDOWN_DRAIN_SECONDS`, ou o processo será morto no meio do dreno (as
mensagens voltam à fila de qualquer forma — sem ack, o broker as reentrega —
mas o log fica menos claro).

---

## Rollback

`MESSAGE_PIPELINE=legacy` + restart volta ao buffer em processo, sem broker.
Mensagens já publicadas nas filas **não** serão consumidas enquanto a flag
estiver em `legacy`; elas ficam lá, e voltam a ser processadas quando o pipeline
`broker` for reativado. Ver [ADR 0009](adrs/0009-rollout-por-flag-message-pipeline.md).
