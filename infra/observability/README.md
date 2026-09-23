# Observabilidade — arquivos versionados

Config de coleta, regras de alerta, dashboards e roteamento de notificação. A
visão geral, o orçamento de cardinalidade e o roteiro de verificação estão em
[docs/observability.md](../../docs/observability.md).

```
../../Dockerfile.alloy             imagem do Alloy no Railway (copia config.alloy)
alloy/
  config.alloy                     coleta em produção (Railway)
  config.alloy.local               a mesma coisa, com alvos locais
  postgres-monitoring-user.sql     usuário somente-leitura do exporter
rabbitmq/enabled_plugins           habilita rabbitmq_prometheus (porta 15692)
alerts/
  whatsapp-pipeline.yaml           filas, DLQ, processamento
  plataforma.yaml                  disponibilidade, recursos, API, pagamentos
  tests/*.test.yaml                testes de promtool das regras acima
dashboards/*.json                  overview, whatsapp-pipeline, api, payments
notifications/contact-points.yaml  canais SEM destino (nada sai para fora)
docker-compose.observability.yml   stack local (Alloy + exporters)
```

## Por que estes formatos, e não "provisionamento por arquivo"

O Grafana Cloud **não suporta provisionamento por arquivo** — a documentação é
explícita: _"Provisioning with configuration files is not available in Grafana
Cloud"_. Não existe diretório de provisioning numa instância gerenciada.

Cada recurso tem, então, o seu caminho:

| Recurso             | Formato aqui            | Como aplica                                             |
| ------------------- | ----------------------- | ------------------------------------------------------- |
| Regras de alerta    | regra do **Prometheus** | `mimirtool rules load` → ruler do Grafana Cloud Metrics |
| Dashboards          | JSON do Grafana         | API de dashboards, `grafanactl`, ou Terraform           |
| Canais e roteamento | export do Grafana       | Terraform ou API de provisionamento de alerting         |

A escolha de regra em formato Prometheus tem um benefício que vale mais que a
conveniência: ela é **testável**. `promtool test rules` monta séries sintéticas e
afirma que o alerta dispara — e que **não** dispara nos casos que não deveriam.
Conferir "Pending → Firing" na UI prova uma vez, num navegador; o teste prova a
cada execução e pega quem ajustar um limiar sem perceber o efeito.

## Subir a stack local

Pré-requisito: `infra/docker/.env` criado a partir do `.env.example` (é de lá que
o Compose lê os `GRAFANA_CLOUD_*`; vazios, o Alloy sobe, coleta e só falha o
envio).

```bash
pnpm obs:up     # infra (Postgres, RabbitMQ, Redis) + Alloy + exporters

# Usuário somente-leitura do postgres-exporter — uma vez por volume do Postgres.
# Sem ele o exporter não autentica e o alvo fica `down`.
docker exec -i financial-vellun-db psql -U vellun -d financial_vellun \
  < infra/observability/alloy/postgres-monitoring-user.sql
```

| Porta           | O quê                                                                          |
| --------------- | ------------------------------------------------------------------------------ |
| `12345`         | UI do Alloy: componentes, alvos e último erro                                  |
| `3100`          | recebimento de logs — `LOKI_PUSH_URL=http://localhost:3100` na API e no agente |
| `9187` / `9121` | postgres-exporter / redis-exporter                                             |

O Alloy local coleta a API, o agente e o worker rodando no host, com o
`METRICS_TOKEN` padrão (`local-dev-metrics-token`) — se trocar o token nos
`.env`, exporte o mesmo valor antes do `obs:up`. Para derrubar: `pnpm obs:down`.
O roteiro completo de verificação está em
[docs/observability.md](../../docs/observability.md#verificação-local).

## Verificar

```bash
pnpm obs:check
```

Roda, em sequência: `alloy validate` nas duas configs, `promtool check rules` nas
regras, `promtool test rules` nos testes e, por último, o `promtool` sobre o
PromQL de todos os painéis dos dashboards. Só precisa de Docker.

A última etapa existe porque um dashboard com consulta inválida importa sem
reclamar: o painel só aparece com um triângulo vermelho, que parece falta de
dado. Se ela falhar, o script imprime em qual arquivo e painel está cada consulta.

Os três passos, se quiser rodar um de cada vez:

```bash
ALLOY=grafana/alloy:v1.19.2
PROM=prom/prometheus:latest

docker run --rm -v "$PWD/infra/observability/alloy:/cfg" $ALLOY validate /cfg/config.alloy
docker run --rm -v "$PWD/infra/observability/alloy:/cfg" $ALLOY validate /cfg/config.alloy.local

docker run --rm --entrypoint promtool -v "$PWD/infra/observability/alerts:/r" $PROM \
  check rules /r/whatsapp-pipeline.yaml /r/plataforma.yaml
docker run --rm --entrypoint promtool -v "$PWD/infra/observability/alerts:/r" $PROM \
  test rules /r/tests/whatsapp-pipeline.test.yaml /r/tests/plataforma.test.yaml
```

## Carregar as regras no Grafana Cloud

As annotations `dashboard` e `runbook` das regras usam os marcadores
`DASHBOARD_BASE` e `RUNBOOK_BASE`. Eles **não** são fixados no repositório porque
a URL da organização no Grafana só existe depois de a stack ser criada, e deixá-la
aqui manteria um valor errado versionado. A substituição acontece no carregamento:

```bash
export GRAFANA_ORG_URL='https://SEU-ORG.grafana.net'
export REPO_DOCS_URL='https://github.com/VellunSolutioins/financial-vellun/blob/main/docs'

mkdir -p /tmp/vellun-rules
for f in infra/observability/alerts/*.yaml; do
  sed -e "s|DASHBOARD_BASE|$GRAFANA_ORG_URL|g" \
      -e "s|RUNBOOK_BASE|$REPO_DOCS_URL|g" "$f" > "/tmp/vellun-rules/$(basename "$f")"
done

mimirtool rules check /tmp/vellun-rules/*.yaml

mimirtool rules load /tmp/vellun-rules/*.yaml \
  --address="$GRAFANA_CLOUD_PROM_URL_BASE" \
  --id="$GRAFANA_CLOUD_PROM_USER" \
  --key="$GRAFANA_CLOUD_TOKEN"
```

`GRAFANA_CLOUD_PROM_URL_BASE` é a base do endpoint de métricas (sem
`/api/prom/push`), como `https://prometheus-prod-XX-prod-sa-east-1.grafana.net`.

`mimirtool rules load` **substitui** os grupos com o mesmo nome. Rodar duas vezes
é seguro; renomear um grupo deixa o antigo órfão no ruler — nesse caso, remova-o
com `mimirtool rules delete`.

## Convenções das regras

- `severity`: `critical` acorda alguém, `warning` espera o horário comercial;
- `service` e `env`: quem e onde, usados pelo roteamento de notificação;
- `summary`: o que aconteceu, em uma linha, sem jargão de métrica;
- `description`: o número concreto, para não precisar abrir o dashboard;
- `dashboard` e `runbook`: onde olhar e o que fazer. **Um alerta sem procedimento
  é um alerta que vai ser silenciado** — se não há o que fazer, o alerta não devia
  existir.

Regras que dependem de métrica de entrega futura (o catálogo de falhas da Entrega
5, as métricas de pagamento da Entrega 8) usam `unless absent(...)` para ficarem
**inertes** em vez de disparar em falso. Há teste cobrindo exatamente esse estado.

## Notificação

Os canais em `notifications/contact-points.yaml` estão declarados **sem destino
real**. Isso é deliberado: preencher endereços antes de calibrar o ruído faria o
primeiro `apply` disparar a bateria inteira para pessoas reais, e a maneira mais
rápida de um sistema de alerta ser ignorado é começar com falso-positivo.
