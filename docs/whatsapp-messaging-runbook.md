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
{
  "status": "ok",
  "pipeline": "broker",
  "broker": "up",
  "consumers": "up",
  "flusher": "up",
  "redis": "up"
}
```

`consumers: "disabled"` e `flusher: "disabled"` são esperados quando
`RUN_CONSUMERS_IN_API=false` (a instância só publica).

`flusher: "down"` com os consumers de pé é grave e silencioso: o texto é ackado
na entrada e fica parado no agrupamento do Redis, sem fila crescendo e sem DLQ.
Reinicie a instância.

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

| Métrica                                                | Leitura                                                                                                                                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook_received` / `publish_confirmed`               | divergência entre os dois indica itens descartados antes de publicar (payload sem mensagem, ou item inválido: `webhook_invalid_item`). Texto longo demais **é** publicado, como não suportado: veja `webhook_text_too_long` |
| `publish_failed`                                       | o webhook devolveu `503`; o provedor vai reenviar                                                                                                                                                                           |
| `webhook_latency_ms`                                   | inclui o _publisher confirm_. Subida sustentada = broker sob pressão                                                                                                                                                        |
| `messages_consumed` / `messages_duplicated`            | duplicadas altas são normais após um reenvio da Meta; sustentadas indicam ack lento                                                                                                                                         |
| `inbound_grouped` / `group_flushed` / `jobs_published` | acompanham o funil de consolidação                                                                                                                                                                                          |
| `receive_to_process_ms`                                | tempo entre receber e começar a processar; inclui o debounce (5 s)                                                                                                                                                          |
| `processing_duration_ms`                               | duração do processamento; dominado pela latência do LLM                                                                                                                                                                     |
| `jobs_deferred`                                        | jobs adiados por lock de telefone. Alto = muita mensagem simultânea do mesmo número                                                                                                                                         |
| `jobs_duplicated`                                      | reentregas descartadas pelo marcador `job:done`                                                                                                                                                                             |
| `transactions_created` / `transactions_idempotent_hit` | lançamentos criados e lançamentos devolvidos por idempotência                                                                                                                                                               |
| `transaction_failed`                                   | a API recusou o lançamento (conta/categoria inválida, sem assinatura)                                                                                                                                                       |
| `whatsapp_send_failed`                                 | falha ao responder ao usuário                                                                                                                                                                                               |
| `dlq` / `dlq_messages`                                 | qualquer valor diferente de zero pede investigação                                                                                                                                                                          |

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

A DLQ é o fim da linha do pipeline: chegar aqui significa que o retry com backoff
já se esgotou, ou que o contrato era inválido desde o começo. Nada se perde — mas
nada anda sozinho a partir daqui.

> **A DLQ é transporte; o Postgres é a fonte de verdade.** Desde a Entrega 5, um
> consumer dedicado drena as duas DLQs para `ops_failed_messages` e só então acka.
> Na prática isso muda por onde você investiga:
>
> - a **DLQ deve estar praticamente vazia** o tempo todo. Profundidade
>   persistente significa que o consumer do catálogo parou — nada se perdeu, as
>   mensagens estão esperando na fila, mas o painel está incompleto;
> - o histórico completo do que falhou está **no catálogo**, com filtro,
>   paginação e ordenação — coisas que a fila não oferece;
> - consultar o catálogo **não consome nada da fila**. Abrir a listagem cem vezes
>   não move uma mensagem.
>
> Os passos abaixo continuam válidos para inspeção direta da fila, que é o que
> resta quando o próprio catálogo está fora.

> **Leia [O painel do RabbitMQ não é um banco de dados](#o-painel-do-rabbitmq-não-é-um-banco-de-dados)
> antes de clicar em qualquer coisa no Management.** Duas operações que parecem
> leitura — "Get messages" e "Purge" — descartam mensagem sem registro.

### 1. Ver o tamanho do estrago

```bash
docker exec financial-vellun-rabbitmq \
  rabbitmqctl list_queues name messages messages_ready messages_unacknowledged consumers
```

Leia as colunas juntas, porque isoladas enganam:

| Sintoma                                    | Leitura                                                              |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `.dlq` com `messages > 0`                  | falha definitiva esperando ação humana                               |
| `.v1` com `messages > 0` e `consumers = 0` | **nada está sendo processado** — o worker caiu; veja `/health/ready` |
| `.retry.*s` com `messages > 0`             | normal: esperam o TTL vencer, e não têm consumidor por construção    |
| `messages_unacknowledged` alto e parado    | consumidor travado segurando mensagem sem ackar                      |

### 2. Ler o envelope

O envelope (`DlqEnvelopeV1`, em `apps/ai-agent/src/messaging/contracts.py`) traz
tudo que o diagnóstico precisa:

```json
{
  "schemaVersion": 1,
  "payload": { "...mensagem original, íntegra..." },
  "sourceQueue": "whatsapp.processing.v1",
  "routingKey": "processing",
  "attempts": 5,
  "errorType": "ConnectionError",
  "errorMessage": "…truncado em 500 caracteres…",
  "permanent": false,
  "firstFailedAt": "2026-09-05T17:59:12Z",
  "failedAt": "2026-09-05T18:00:00Z",
  "correlationId": "…"
}
```

O campo que decide o que fazer é o `permanent`:

- **`permanent: true`** → contrato inválido ou tipo não suportado. **Reprocessar
  não resolve**: a mensagem falha de novo, do mesmo jeito. Corrija a origem — ou
  aceite que aquela mensagem não é processável — e descarte com registro.
- **`permanent: false`** → as tentativas se esgotaram contra uma causa externa
  (API principal fora, OpenAI indisponível, Redis inacessível). Resolva a causa e
  então reprocesse.

As **duas datas são campos diferentes**, e confundi-las leva a diagnóstico errado:

- `firstFailedAt` — quando a mensagem tropeçou pela **primeira** vez. Viaja no
  header `x-first-failed-at`, escrito no primeiro retry.
- `failedAt` — quando ela **desistiu**, depois de esgotar as tentativas.

A distância entre as duas diz se você está diante de uma falha nova ou de algo que
vem se arrastando. `firstFailedAt` vem nulo quando a falha foi permanente logo na
primeira tentativa: aí não houve retry, e as duas datas seriam a mesma.

O `correlationId` é a ponte para o resto da investigação: com ele,
`{service="ai-agent"} |= "<id>"` no Loki mostra o caminho inteiro da mensagem, do
webhook até a falha.

### 3. Investigar a causa — **antes** de reprocessar

Reprocessar sem resolver a causa devolve a mensagem à mesma parede: ela percorre
os cinco retries de novo e volta para a DLQ minutos depois, com o `attempts`
zerado e um `failedAt` novo. O único efeito é apagar o rastro de quando ela falhou
pela primeira vez.

```bash
# A causa ainda está de pé?
curl -s http://localhost:8010/health/ready   # broker, consumers, redis
curl -s http://localhost:3001/health/ready   # postgres
```

Confirme que o `errorType` bate com o que você corrigiu. Um `ConnectionError` que
some depois de a API principal voltar é uma coisa; um `ValidationError`
recorrente é outra, e nenhum restart conserta.

> **Reprocessar um job de `processing` cuja entrega falhou não refaz o job.**
> A resposta calculada fica em `job:reply:{jobId}` (TTL `JOB_DEDUPE_TTL_SECONDS`)
> e o reprocessamento só a reenvia. Corrija a causa da recusa (token, número)
> antes de republicar.

### 4. Republicar

Não há shovel configurado. O caminho é republicar o **conteúdo do campo
`payload`** — não o envelope inteiro — na exchange principal, com a routing key de
origem:

| Campo do envelope | Para onde vai                           |
| ----------------- | --------------------------------------- |
| `payload`         | corpo da mensagem                       |
| `routingKey`      | routing key (`inbound` ou `processing`) |
| —                 | exchange: `whatsapp.x`                  |

Pelo painel: **Exchanges → `whatsapp.x` → Publish message**, com
`delivery_mode = 2`. Pela linha de comando, que é reproduzível e deixa rastro no
histórico do shell:

```bash
curl -u "$RABBITMQ_USER:$RABBITMQ_PASSWORD" -H 'content-type: application/json' \
  -X POST http://localhost:15672/api/exchanges/%2F/whatsapp.x/publish \
  -d '{
        "properties": { "delivery_mode": 2 },
        "routing_key": "processing",
        "payload": "COLE_AQUI_O_CAMPO_payload_DO_ENVELOPE",
        "payload_encoding": "string"
      }'
```

`{"routed":true}` confirma que a exchange encontrou uma fila. `{"routed":false}`
significa routing key errada — a mensagem foi descartada e republicar com a key
certa é seguro.

Republicar não duplica: os três níveis de idempotência
([ADR 0005](adrs/0005-idempotencia-em-tres-niveis.md)) impedem `AiMessage`
duplicada, job duplicado e lançamento duplicado.

### 5. Confirmar o resultado

Republicar não é concluir.

```bash
# A fila consumiu a mensagem republicada?
docker exec financial-vellun-rabbitmq rabbitmqctl list_queues name messages consumers

# O processamento terminou? (jobs_processed sobe; processing_error NÃO sobe)
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:8010/metrics.json
```

Siga o `correlationId` no Loki até o lançamento criado. Se a mensagem voltou para
a DLQ com `attempts` reiniciado, a causa **não** estava resolvida e o passo 3
precisa ser refeito.

---

## O painel do RabbitMQ não é um banco de dados

O Management é a ponte enquanto o catálogo de falhas (Entrega 5) não existe. Ele
serve, mas tem duas armadilhas que custam mensagem — e as duas parecem operação
de leitura.

### "Get messages" é uma operação **sobre a fila**, não um `SELECT`

Ela não espia: ela **consome**. Com `requeue = Yes` a mensagem é entregue ao
cliente e devolvida ao fim; com `requeue = No` ela é ackada e **some para sempre**.

Três comportamentos medidos nesta stack (RabbitMQ 3.13.7, filas clássicas),
porque a diferença entre eles separa diagnóstico de perda de dado.

**1. `requeue = No` remove a cabeça da fila, não "a sua" mensagem.**

Este é o erro caro, e o procedimento anterior deste runbook induzia a ele. O
cenário: você republicou a `mensagem-3` e quer removê-la da DLQ, então usa "Get
messages" com `count = 1` e `requeue = No`. Resultado medido:

```
fila antes:                         [msg-1, msg-2, msg-3, msg-4, msg-5]
get(count=1, requeue=No) devolveu:   msg-1
fila depois:                        [msg-2, msg-3, msg-4, msg-5]
```

A `msg-1` — que ninguém tratou — foi descartada sem registro, e a `msg-3`
continua lá. **Não existe forma de remover uma mensagem específica pelo painel.**
Precisando remover só uma, consuma a fila por um script que decide item a item,
ou espere o catálogo da Entrega 5.

**2. `requeue = Yes` preservou a ordem nesta versão — mas não construa
procedimento sobre isso.**

Medimos porque a garantia é citada nos dois sentidos: pegar as duas primeiras de
cinco e devolvê-las manteve `[1, 2, 3, 4, 5]` em três repetições. Ainda assim, a
ordem após um requeue é detalhe de implementação do tipo de fila e da versão —
trate como "provavelmente preservada", nunca como invariante.

**3. "Get messages" só enxerga mensagem `ready`.**

Mensagem já entregue a um consumidor (estado `unacked`) é **invisível** para o
painel. No teste, com um consumidor segurando quatro mensagens sem ackar, o "Get
messages" devolveu **nada** — enquanto os contadores ainda exibiam `ready = 4`,
porque as estatísticas do Management têm atraso.

É por isso que "sei que a mensagem falhou, mas não a vejo na fila" é comum e não
significa que ela sumiu. Pare o consumidor daquela fila antes de inspecionar, ou
confie no `correlationId` no Loki em vez do painel.

### "Purge" não é procedimento de recuperação

`Purge` descarta a fila inteira **sem registro nenhum**: sem log do que havia, sem
cópia, sem forma de saber depois quantas mensagens foram perdidas nem de quem
eram. Numa DLQ, cada mensagem descartada é um lançamento que o cliente mandou e
que nunca vai aparecer.

Use `Purge` apenas quando as duas condições valerem juntas:

- a fila é de ambiente descartável (a sua máquina, nunca produção); **e**
- você já sabe o que há nela e decidiu conscientemente perder.

Em produção o caminho é sempre republicar o que deve voltar e **registrar** o que
foi descartado — hoje anotando fora do broker; a partir da Entrega 5, marcando a
linha como `discarded` em `ops_failed_messages`, com operador e justificativa.

### Acesso ao Management

Credencial própria, de privilégio mínimo. O painel não deve ser acessado com o
usuário da aplicação:

```bash
docker exec financial-vellun-rabbitmq rabbitmqctl add_user vellun_monitor 'SENHA'
docker exec financial-vellun-rabbitmq rabbitmqctl set_user_tags vellun_monitor monitoring
# Sem permissão em vhost: monitoramento não publica, não consome, não apaga fila.
```

A tag `monitoring` dá leitura do painel e das métricas sem poder mexer nas filas —
o que também torna as duas armadilhas acima inacessíveis por acidente. Republicar
exige um usuário com escrita no vhost, e isso é decisão consciente, não o padrão.

---

## Webhook deu 202, mas o usuário não recebeu resposta

O `202` só prova que a mensagem entrou em `whatsapp.inbound.v1`. Para achar onde
ela parou, leia os contadores em `/metrics.json` do agente: o último que subiu
aponta o salto. O passo a passo, com a tabela de leitura, está em
[whatsapp-flow-gap-analysis.md](whatsapp-flow-gap-analysis.md#roteiro-de-diagnóstico).

Sinais que só existem desde essa análise:

- **O agente não sobe em produção** com `MessengerConfigError` no log: falta
  `WHATSAPP_PROVIDER=cloud-api`, `WHATSAPP_PROVIDER_TOKEN` ou
  `WHATSAPP_PHONE_NUMBER_ID`. É intencional — antes ele subia e respondia só no log.
- **`whatsapp_send_failed` subindo**: a Graph API recusou ou ficou inalcançável.
  `429`/`5xx`/rede retentam; outros `4xx` (token expirado é o clássico) vão direto
  para a DLQ, com o código da Meta no `errorMessage`.
- **`jobs_reply_resumed`**: um retry que só reenviou a resposta já calculada.
  Normal em instabilidade do WhatsApp; o job não é reprocessado.
- **`dlq_user_notified`**: o usuário recebeu o aviso de que a mensagem falhou.
  `dlq_user_notice_suppressed` é a janela `DLQ_USER_NOTICE_COOLDOWN_SECONDS`
  segurando avisos repetidos; `dlq_user_notice_failed` quase sempre acompanha
  `whatsapp_send_failed`.

A primeira linha de log da subida (`Configuração efetiva: ...`) diz qual
messenger está ativo, a `MAIN_API_URL` e o que está ou não configurado.

### Rastrear uma mensagem salto a salto

`scripts/trace_message.py` envia **um** webhook de texto no formato da Meta e narra
cada etapa conforme acontece, com o tempo desde o envio. No fim, confere no Postgres
a mensagem, a resposta registrada e o último lançamento. Sai com código 1 se a
mensagem não chegar a `jobs_processed`.

```bash
cd apps/ai-agent
.venv/Scripts/python.exe scripts/trace_message.py "gastei 42,90 na padaria"
.venv/Scripts/python.exe scripts/trace_message.py "oi" --phone +5541977775555   # não vinculado
```

```
[    203 ms] 1 WEBHOOK     HTTP 202 {"status":"accepted","published":1}
[    219 ms] 2 INBOUND     consumer tirou o evento de whatsapp.inbound.v1
[    313 ms] 2 INBOUND     mensagem persistida na API e gravada no agrupamento → ack
               Redis: group:+5511999999999 com 1 mensagem(ns); flush em ~4.8s
[   6719 ms] 3 FLUSHER     job publicado em whatsapp.processing.v1
[   8078 ms] 4 PROCESSING  LLM classificou a intenção
[   8172 ms] 4 PROCESSING  lançamento criado na API
[   8172 ms] 5 RESPOSTA    resposta entregue ao messenger e job concluído
```

Cria um lançamento de verdade — use um telefone de teste e `WHATSAPP_PROVIDER=log`.
Com `log`, a "entrega" é a linha `[WhatsApp -> +55...]` no log do agente.

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
