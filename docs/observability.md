# Observabilidade — coleta, orçamento de cardinalidade e verificação

Como métricas e logs saem dos três serviços e chegam ao Grafana Cloud, quanto
isso custa em séries, e como validar tudo nesta máquina antes de tocar em
produção.

Complementa o [runbook do pipeline WhatsApp](whatsapp-messaging-runbook.md), que
cobre o que fazer quando um alerta dispara.

---

## Arquitetura

```
  ┌──────────────┐  scrape /metrics (Bearer)   ┌─────────┐  remote_write  ┌──────────────┐
  │ api          │◄────────────────────────────┤         ├───────────────►│              │
  │ ai-agent     │                             │  Alloy  │                │ Grafana      │
  │ (ai-agent-   │  POST /loki/api/v1/push     │         │  push          │ Cloud        │
  │  worker)*    ├────────────────────────────►│         ├───────────────►│              │
  └──────────────┘                             └────┬────┘                └──────────────┘
                                                    │ scrape
  ┌────────────────────────────────────────────┐     │
  │ rabbitmq :15692 (plugin nativo)            │◄────┘
  │ (postgres-exporter :9187)*                 │
  │ (redis-exporter :9121)*                    │
  └────────────────────────────────────────────┘
```

\* Ainda não existem no Railway. Hoje o agente roda webhook e consumers no mesmo
serviço (`RUN_CONSUMERS_IN_API=true`), então as métricas dos consumers saem em
`job="ai-agent"`; e os exporters não foram criados. Os alvos estão comentados em
`config.alloy` — ver [Produção no Railway](#produção-no-railway).

O Alloy é o **único** componente com credencial do Grafana Cloud. Os serviços de
aplicação conhecem apenas o endereço do Alloy na rede privada.

### Métricas: o Alloy busca

Scrape a cada 30 s nas aplicações e 60 s na infraestrutura, com
`Authorization: Bearer ${METRICS_TOKEN}` nas aplicações. `/metrics` fica fechado
sem o token — a exposição não é inócua: nomes de rota revelam a superfície da API
e contadores revelam volume de negócio.

**O RabbitMQ tem dois scrapes, e a razão não é cosmética.** A porta 15692 devolve,
por padrão, métricas **agregadas**: `rabbitmq_queue_messages_ready` vem sem o
label `queue`, somando todas as filas. Com isso os dois alertas centrais do
pipeline — "fila com mensagem e zero consumidores" e "nova entrada em DLQ" —
seriam inexprimíveis, porque não haveria como distinguir `whatsapp.processing.dlq`
de `whatsapp.inbound.v1`.

O label vem de `/metrics/detailed`, com o prefixo `rabbitmq_detailed_`. Pedimos
**apenas duas famílias** (`queue_coarse_metrics` e `queue_consumer_count`): o
endpoint inteiro traz milhares de séries, e este par custa 77. Pedir `family=`
explicitamente é o que separa "por fila" de "estoura o free tier".

### Logs: as aplicações empurram

**O Railway não tem log drain.** O plano original previa receber um "log drain
HTTP do Railway" no `loki.source.api`; isso não existe. A
[documentação do Railway](https://docs.railway.com/observability/logs) é explícita
("Railway does not have a log drain setting") e oferece dois caminhos: um
forwarder que leia stdout de outro container, ou a própria aplicação emitir.

Escolhemos o segundo, e a troca é honesta:

| | A favor | Contra |
| --- | --- | --- |
| App empurra | Log sai já estruturado e correlacionado, sem parsear texto. Credencial do Grafana fica só no Alloy. | O processo conhece o endereço do Alloy. Buffer em memória pode descartar sob pressão. |
| Forwarder lendo stdout | App não sabe que observabilidade existe. | No Railway, um container não lê o stdout de outro — exigiria sidecar por serviço. |

As três invariantes do transporte (`apps/api/src/observability/loki-transport.ts`
e `apps/ai-agent/src/observability/loki_handler.py`):

1. **nunca interrompe a aplicação** — falha de rede, 500 do Alloy, DNS errado:
   nada propaga;
2. **nunca bloqueia** — buffer em memória, envio em lote em tarefa própria;
3. **nunca cresce sem limite** — teto de 1.000 linhas, descarte contado, e o
   descarte é da **mais antiga** (durante um incidente a linha recente é a que
   explica o que está acontecendo agora).

O stdout continua recebendo tudo. O envio ao Loki é adicional, não substituto: se
ele falhar, o log ainda está no Railway.

Ativado apenas com `LOKI_PUSH_URL` definido. Sem a variável o transporte não
existe — em desenvolvimento não há Alloy, e tentar conectar em nada geraria ruído.

---

## Orçamento de cardinalidade

O free tier do Grafana Cloud dá **10.000 séries ativas por mês**. Estourar não dá
erro: a conta passa a cobrar ou o Grafana descarta série, em silêncio. Por isso o
orçamento é medido, não estimado.

### Medição (2026-09-09, uma réplica de cada serviço, nesta máquina)

| job               | bruto | enviado | cortado |
| ----------------- | ----: | ------: | ------: |
| api               |   153 |     153 |       – |
| ai-agent          |   142 |     142 |       – |
| ai-agent-worker   |   142 |     142 |       – |
| rabbitmq          | 2.682 |     263 |  −2.419 |
| postgres          | 1.116 |     709 |    −407 |
| redis             |   649 |     330 |    −319 |
| alloy             |   571 |     535 |     −36 |
| **total**         | 5.455 | **2.274** | −3.181 |

Com a API aquecida (55 rotas registradas × ~3 status × 13 séries do histograma),
a projeção é **~4.400 séries, 44% do teto** — folga suficiente para uma segunda
réplica da API, não para quatro.

A medição é da stack local completa. Na topologia atual do Railway não há
`ai-agent-worker`, `postgres` nem `redis` sendo coletados, então o consumo real
fica abaixo disso; os números continuam valendo para quando esses alvos forem
ativados.

Reproduzir a medição: ver [Verificação local](#verificação-local) abaixo.

### O que os cortes descartam, e por quê

Em `prometheus.relabel "corta_ruido"` (`infra/observability/alloy/config.alloy`):

| Regra | Devolve | Perda aceitável porque |
| --- | ---: | --- |
| `erlang_vm_(allocators\|msacc_.*\|dist_.*\|statistics_garbage_collection)` | ~2.370 | Diagnostica a VM Erlang, não o nosso pipeline. O painel do RabbitMQ mostra ao vivo se precisar. |
| `redis_(latency_percentiles\|commands_latencies)_.*` | ~320 | Usamos Redis para agrupamento e lock; interessa `redis_up`, memória e conexões — não a distribuição por comando. |
| `pg_statio_user_.*` | ~150 | Mantemos `pg_stat_user_tables_*`, que responde "falta índice aqui?". |

> **Uma regra que existiu e foi removida.** Havia um descarte de `pg_settings_.*`
> (255 séries de configuração do servidor, constantes entre scrapes). Ele saiu
> porque o alerta `ConexoesDoPostgresProximasDoLimite` precisa de
> `pg_settings_max_connections`, e a regex do Prometheus é RE2 — sem lookahead,
> "descarte `pg_settings_` exceto `max_connections`" só sairia como uma alternância
> longa que quebraria calada na próxima versão do exporter. 255 séries (2,5% do
> teto) é preço justo por um alerta que funciona.

> **Cuidado com o formato do nome.** `erlang_vm_allocators` é **um** nome de
> métrica com 1.744 combinações de label, sem sufixo. Uma versão anterior da
> regra era `erlang_vm_(...allocators...)_.*` — exigia o underscore e cortava 678
> séries em vez de 2.370. Ao mexer numa regra, **meça** o efeito; a config
> continua válida e o corte simplesmente não acontece.

### Regra de labels

`correlationId`, `jobId`, telefone, e-mail, id de usuário e conteúdo de mensagem
**nunca** viram label — nem em métrica, nem em stream do Loki. Vão para o corpo do
log, e o log é a ponte.

Na API, `route` é sempre o padrão (`/transactions/:id`) e requisição sem rota
casada é agrupada em `route="unmatched"`. No agente, há teste que varre o registro
e falha se qualquer métrica ganhar label
(`tests/test_metrics.py::test_nenhuma_metrica_usa_label`).

---

## Versões pinadas

Confirmadas na documentação oficial em **2026-09-09**. `latest` não é usado: um
exporter que renomeia métrica entre versões esvazia dashboard e alerta em
silêncio.

| Componente | Versão | Lançamento |
| --- | --- | --- |
| `grafana/alloy` | `v1.19.2` | 2026-08-26 |
| `prometheuscommunity/postgres-exporter` | `v0.20.1` | 2026-07-07 |
| `oliver006/redis_exporter` | `v1.91.1` | 2026-09-07 |
| `rabbitmq_prometheus` | plugin do `rabbitmq:3.13` | — |

Limites do free tier do Grafana Cloud na mesma data: **10 mil séries ativas/mês**,
**50 GB de log/mês**, retenção de **14 dias** para métricas, logs e traces. Esses
números mudam — reconfira antes de dimensionar.

Preferimos o plugin nativo do RabbitMQ a um exporter externo: ele lê o estado
interno do broker sem passar pela API de gerenciamento, que é a mesma usada pelo
painel e degrada sob carga.

---

## Variáveis de ambiente

Nas variáveis do Railway, nunca no repositório.

### Alloy

| Variável | Para quê |
| --- | --- |
| `GRAFANA_CLOUD_PROM_URL` / `_USER` | endpoint e id da instância do Prometheus |
| `GRAFANA_CLOUD_LOKI_URL` / `_USER` | endpoint e id da instância do Loki |
| `GRAFANA_CLOUD_TOKEN` | token com escopo de **escrita** apenas |
| `METRICS_TOKEN` | o mesmo aceito por `/metrics` dos três serviços |
| `ENVIRONMENT` | vira o label `env` de toda série e todo log |

### Serviços de aplicação

| Variável | Para quê |
| --- | --- |
| `METRICS_TOKEN` | Bearer exigido em `/metrics`. **Mesmo valor** nos três. |
| `PORT` | `3001` na API, `8010` no agente. O Alloy scrapa porta fixa; sem ela o Railway pode atribuir outra e o alvo fica `down`. |
| `LOKI_PUSH_URL` | `http://alloy.railway.internal:3100`. Sem ela, sem envio de log. Preencher **depois** de o Alloy estar no ar. |
| `WORKER_METRICS_PORT` | porta do HTTP mínimo do worker (padrão 8011) |

### Painel de operações (só na API)

O painel **não consulta** o Grafana: ele leva até lá. Por isso basta a URL
pública da organização, sem token de leitura no backend. Ausentes, os atalhos
somem da tela em vez de virarem link quebrado.

| Variável | Para quê |
| --- | --- |
| `OPS_GRAFANA_URL` | base da organização, ex.: `https://SEU-ORG.grafana.net`. Monta os links dos quatro dashboards. |
| `OPS_GRAFANA_LOKI_DATASOURCE_UID` | UID da fonte Loki (Connections → Data sources → a URL termina em `/datasources/edit/<uid>`). Sem ela não há Explore filtrado por `correlationId` no detalhe da falha. |

### Contas de monitoramento com privilégio mínimo

**Postgres** — `infra/observability/alloy/postgres-monitoring-user.sql` cria
`vellun_monitor` com o papel predefinido `pg_monitor` (acesso às visões
`pg_stat_*` sem leitura de dado algum) e `CONNECTION LIMIT 5`. Não há
`GRANT SELECT ON ALL TABLES` — esse é o erro comum desta configuração.

```bash
psql "$DATABASE_URL" -f infra/observability/alloy/postgres-monitoring-user.sql
```

**RabbitMQ** — usuário com a tag `monitoring`, que dá acesso às métricas e ao
painel em modo leitura, sem poder publicar, consumir ou apagar fila:

```bash
rabbitmqctl add_user vellun_monitor '<senha>'
rabbitmqctl set_user_tags vellun_monitor monitoring
# Sem permissão em vhost: monitoramento não precisa tocar em fila.
```

O plugin `rabbitmq_prometheus` na 15692 não exige autenticação, então **a porta
não deve ser exposta publicamente** — restrinja à rede privada.

O mesmo vale para a 3100 do Alloy: quem a alcança pode injetar linha de log.

---

## Produção no Railway

### A imagem

O Railway não monta arquivo do repositório dentro de uma imagem pronta, então o
Alloy sobe a partir de [`Dockerfile.alloy`](../Dockerfile.alloy), na raiz — mesmo
padrão do `Dockerfile.ai-agent`. Ela é a `grafana/alloy:v1.19.2` com
`infra/observability/alloy/config.alloy` copiado para `/etc/alloy/config.alloy`,
e o comando padrão da imagem oficial.

Duas consequências:

- **mudar `config.alloy` exige redeploy do serviço `alloy`** — o arquivo está
  dentro da imagem;
- sem volume, o WAL do `remote_write` (`/var/lib/alloy/data`) não sobrevive a um
  restart: perde-se o que ainda não tinha sido enviado, alguns minutos de
  amostra no pior caso.

A UI de diagnóstico fica em `127.0.0.1:12345`, só dentro do container.

### Nomes e portas

O `config.alloy` endereça os serviços pelo nome interno do Railway
(`<serviço>.railway.internal`), que é o nome do serviço no painel. **Renomear um
serviço lá quebra o scrape aqui.**

| Serviço no Railway          | Alvo no `config.alloy` | `job`             | Estado                                       |
| --------------------------- | ---------------------- | ----------------- | -------------------------------------------- |
| `financial-vellun-api`      | `:3001/metrics`        | `api`             | ativo — exige `PORT=3001`                    |
| `financial-vellun-ai-agent` | `:8010/metrics`        | `ai-agent`        | ativo — exige `PORT=8010`                    |
| `rabbitmq`                  | `:15692`               | `rabbitmq`        | ativo — exige o plugin `rabbitmq_prometheus` |
| worker separado             | `:8011/metrics`        | `ai-agent-worker` | comentado                                    |
| `postgres-exporter`         | `:9187`                | `postgres`        | comentado                                    |
| `redis-exporter`            | `:9121`                | `redis`           | comentado                                    |

**Por que os comentados estão comentados, e não só `down`.** Um alvo ativo sem
serviço gera `up == 0` para sempre, e isso é `ServicoIndisponivel` ou
`InfraestruturaIndisponivel` em `critical` permanente — o caminho mais curto para
alguém silenciar o alerta. Comentado, o `job` não existe e nada dispara. Pelo
mesmo motivo `AusenciaInesperadaDeDados` só cita `api`, `ai-agent` e `rabbitmq`:
`absent()` dispara justamente quando a série nunca aparece. Ao criar um desses
serviços, descomente o alvo **e** inclua o `job` no `absent()`.

O worker só existe com `RUN_CONSUMERS_IN_API=false` e `python -m src.worker` num
serviço próprio. Hoje os consumers rodam dentro do agente e suas métricas saem em
`job="ai-agent"` — os painéis e alertas do pipeline não filtram por `job`, então
funcionam igual.

### IPv6 na rede privada

A rede privada do Railway é **só IPv6** em ambientes criados antes de
2025-10-16 e **dual-stack** nos posteriores. Isso decide quem consegue falar com
quem:

- **Alloy recebendo log** — `loki.source.api` ouve em `::`. No Go isso aceita
  IPv4 e IPv6 (conferido: socket em `tcp6` e push IPv4 respondendo `204`), então
  funciona nos dois tipos de ambiente;
- **API** — `app.listen(port)` sem host já ouve em `::` dual-stack no Node;
- **agente** — ouve em `0.0.0.0`, ou seja, só IPv4. Funciona num ambiente
  dual-stack, que deve ser o caso deste projeto (o monorepo é de 2026-06, bem
  depois da mudança). Se `up{job="ai-agent"}` ficar em 0 com a API em 1, é o
  primeiro suspeito.

> **Não troque o agente para `--host ::` achando que é dual-stack.** O
> `asyncio` liga `IPV6_V6ONLY` em todo socket IPv6 que cria, então
> `uvicorn --host ::` passa a recusar IPv4 — e o webhook público do WhatsApp pode
> parar. Conferido subindo a imagem: `[::1]` responde, `127.0.0.1` não. Se um dia
> `up{job="ai-agent"}` ficar em 0 por causa de IPv6, a correção precisa de um
> socket dual-stack de verdade (criado fora do asyncio e entregue ao uvicorn, ou
> outro servidor ASGI com dois `--bind`), não só da troca do host.

### Ordem de configuração

A ordem importa porque cada passo depende do anterior estar de pé, e as falhas
são caladas: scrape sem porta fixa fica `down` sem erro na aplicação, e push de
log sem Alloy é descartado pelo transporte best-effort.

1. **Criar o serviço `alloy`** a partir do repositório, com _Dockerfile Path_ =
   `Dockerfile.alloy`, e as variáveis da [tabela do Alloy](#alloy). `METRICS_TOKEN`
   é o **mesmo** da API e do agente. **Sem domínio público.**
2. **Fixar as portas**: `PORT=3001` na API e `PORT=8010` no agente, e redeploy.
3. **Conferir os alvos** no Grafana Cloud: `up{job="api"}`, `up{job="ai-agent"}`
   e `up{job="rabbitmq"}` valendo 1. Se `rabbitmq` ficar 0, o plugin
   `rabbitmq_prometheus` não está habilitado ou o serviço não se chama `rabbitmq`.
4. **Só então** `LOKI_PUSH_URL=http://alloy.railway.internal:3100` na API e no
   agente, e redeploy.

---

## Verificação local

Não há ambiente de staging, então "ambiente isolado" é esta máquina. O compose de
observabilidade existe exatamente para não exercitar alerta em produção.

```bash
# Infra + observabilidade. A ordem dos -f importa: os bind mounts são
# resolvidos contra o diretório do PRIMEIRO arquivo (infra/docker/).
docker compose -f infra/docker/docker-compose.yml \
               -f infra/observability/docker-compose.observability.yml up -d

# Usuário de monitoramento do Postgres (uma vez)
docker exec -i financial-vellun-db psql -U vellun -d financial_vellun \
  < infra/observability/alloy/postgres-monitoring-user.sql

# Confirmar o privilégio mínimo: o primeiro funciona, o segundo FALHA
docker exec -i financial-vellun-db psql -U vellun -d financial_vellun \
  -c "SET ROLE vellun_monitor; SELECT count(*) FROM pg_stat_activity;"
docker exec -i financial-vellun-db psql -U vellun -d financial_vellun \
  -c "SET ROLE vellun_monitor; SELECT count(*) FROM users;"
```

Validar a config **antes** de subir — o binário reprova argumento inexistente:

```bash
docker run --rm -v "$PWD/infra/observability/alloy:/cfg" \
  grafana/alloy:v1.19.2 validate /cfg/config.alloy
docker run --rm -v "$PWD/infra/observability/alloy:/cfg" \
  grafana/alloy:v1.19.2 validate /cfg/config.alloy.local
```

### Todos os alvos `up`

A UI do Alloy em <http://localhost:12345> mostra cada componente, seus alvos e o
último erro. Pela API:

```bash
curl -s http://localhost:12345/api/v0/web/components/prometheus.scrape.aplicacoes \
  | python -c "
import json,sys
for item in json.load(sys.stdin).get('debugInfo') or []:
    a={x['name']:x['value'].get('value') for x in item['body'] if x['type']=='attr'}
    print(f\"  {a.get('health','?'):5}  {a.get('url','?')}\")"
```

O alvo do worker fica `down` até `pnpm agent:worker` rodar — o que é o correto, e
é justamente o par que o alerta "fila com mensagem e zero consumidores" compara.

### Logs chegando

```bash
# Suba a API com o envio ligado
LOKI_PUSH_URL=http://localhost:3100 NODE_ENV=production node apps/api/dist/main

# Gere uma linha e veja o contador do Alloy subir
curl -s -o /dev/null -H "x-correlation-id: teste-1" http://localhost:3001/rota/inexistente
curl -s http://localhost:12345/metrics | grep loki_source_api_entries_written
```

A rede de segurança da sanitização — `loki.process "sanitiza"` derruba a linha
inteira se vier algo com cara de credencial, porque perder uma linha de log é
melhor que persistir um segredo com 14 dias de retenção:

```bash
NS=$(( $(date +%s) * 1000000000 ))
curl -s -X POST http://localhost:3100/loki/api/v1/push -H 'Content-Type: application/json' \
  -d "{\"streams\":[{\"stream\":{\"service\":\"teste\"},\"values\":[[\"$NS\",\"-----BEGIN RSA PRIVATE KEY----- x\"]]}]}"

curl -s http://localhost:12345/metrics | grep loki_process_dropped_lines_total
# → reason="possivel_segredo_no_log"
```

### Reproduzir o orçamento de cardinalidade

O script abaixo lê as regexes **do próprio `config.alloy`**, então a medição não
pode divergir da config:

```bash
python - <<'PY'
import re, urllib.request, pathlib
cfg = pathlib.Path("infra/observability/alloy/config.alloy").read_text(encoding="utf-8")
blocos = re.findall(r'prometheus\.relabel "(\w+)" \{(.*?)\n\}', cfg, re.S)
regras = {n: re.findall(r'regex\s+= "([^"]+)"', c) for n, c in blocos}

def series(url, token=None):
    req = urllib.request.Request(url)
    if token: req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=15) as r:
        t = r.read().decode("utf-8", "replace")
    return [re.split(r"[{ ]", l, 1)[0] for l in t.splitlines() if l and not l.startswith("#")]

TOK = "local-dev-metrics-token"
alvos = [("api","http://localhost:3001/metrics",TOK,[]),
         ("ai-agent","http://localhost:8010/metrics",TOK,[]),
         ("ai-agent-worker","http://localhost:8011/metrics",TOK,[]),
         ("rabbitmq","http://localhost:15692/metrics",None,regras["corta_ruido"]),
         ("postgres","http://localhost:9187/metrics",None,regras["corta_ruido"]),
         ("redis","http://localhost:9121/metrics",None,regras["corta_ruido"]),
         ("alloy","http://localhost:12345/metrics",None,regras["corta_ruido_alloy"])]

total = 0
for nome, url, tok, drops in alvos:
    nomes = series(url, tok)
    p = re.compile("^(" + "|".join(drops) + ")$") if drops else None
    mantidos = [n for n in nomes if not (p and p.match(n))]
    total += len(mantidos)
    print(f"{nome:<18}{len(nomes):>7} bruto {len(mantidos):>7} enviado")
print(f"\nTOTAL {total} de 10.000 ({total/10000:.0%} do free tier)")
PY
```

---

## Alertas e dashboards

Os arquivos estão em [`infra/observability/`](../infra/observability/README.md),
que documenta o formato de cada um e como carregar. Dois pontos que mudam a forma
de trabalhar:

**O Grafana Cloud não suporta provisionamento por arquivo** — não existe diretório
de provisioning numa instância gerenciada. Então: regras de alerta vão para o
ruler com `mimirtool rules load`, dashboards pela API/Terraform, e canais de
notificação por Terraform ou pela API de alerting. Os arquivos ficam versionados
para a configuração ser revisável em PR em vez de existir só como cliques.

**Os alertas são testados, não conferidos na UI.** Regra em formato Prometheus é
testável: `promtool test rules` monta séries sintéticas e afirma que o alerta
dispara — e que **não** dispara quando não deveria. Um comando roda tudo:

```bash
pnpm obs:check
```

São 33 casos, cobrindo os dois critérios de aceite ("derrubar o consumidor dispara
fila sem consumidor", "forçar uma mensagem para a DLQ dispara nova entrada em
DLQ") e, principalmente, os casos de **não** disparo, que são a metade esquecida:
fila vazia de madrugada, fila de retry (que não tem consumidor por construção),
divisão por zero sem tráfego, deploy de um minuto, e métrica de entrega futura
ainda ausente. Um alerta que dispara sempre é indistinguível de um alerta quebrado.

Nenhuma notificação sai para fora: os canais em
`infra/observability/notifications/contact-points.yaml` estão declarados **sem
destino real**, porque preencher endereços antes de calibrar o ruído faria o
primeiro `apply` disparar a bateria inteira para pessoas de verdade.

## O que ainda depende de conta e painel

Estas etapas não estão no repositório porque o Railway e o Grafana Cloud são
operados pelo painel — a maior fragilidade do conjunto, registrada em
[Riscos do plano](../plan/operacoes-e-observabilidade-plan.md).

- criar a stack no Grafana Cloud e gerar o token de escrita;
- criar o serviço do Alloy no Railway a partir de `Dockerfile.alloy`, seguindo a
  [ordem de configuração](#ordem-de-configuração);
- criar os dois serviços de exporter, e então descomentar os alvos em
  `config.alloy` e incluí-los no `absent()` de `AusenciaInesperadaDeDados`;
- **não** expor publicamente as portas 3100 (Alloy) e 15692 (RabbitMQ);
- carregar as regras (`mimirtool rules load`) e importar os dashboards;
- preencher o destino dos canais de notificação, **depois** de os alertas rodarem
  alguns dias e o ruído ser calibrado.

Verificado nesta máquina: os seis alvos de scrape `up`, o token de métricas
recusando scrape sem Bearer (401), o envio de log chegando ao `loki.source.api` e
a regra de descarte de segredo disparando. A última perna — Alloy → Grafana Cloud
— exige credencial da conta e ainda não foi exercitada.
