# Plano — subir o Alloy no Railway

## Contexto

O pipeline durável do WhatsApp já está em produção no Railway (PR #10), com API,
agente de IA, Postgres, Redis e RabbitMQ no ar. Falta a última perna da
observabilidade: **não existe serviço Alloy**, e por isso os quatro dashboards já
importados no Grafana Cloud estão vazios e `LOKI_PUSH_URL` está em branco na API
e no agente.

Duas coisas impedem simplesmente criar o serviço hoje:

1. o Railway não permite montar `infra/observability/alloy/config.alloy` numa
   imagem pronta — é preciso uma imagem com o config dentro;
2. `config.alloy` foi escrito antes de a topologia existir e aponta para nomes de
   serviço que nunca foram criados (`api`, `ai-agent-web`, `ai-agent-worker`), e
   o alerta `AusenciaInesperadaDeDados` exige um `ai-agent-worker` que não existe
   nesta topologia — ele dispararia `critical` permanente 10 minutos depois de o
   Alloy subir.

Resultado esperado: um PR pequeno depois do qual criar o serviço Alloy no Railway
seja só configurar variáveis, sem editar nada do repositório.

Fora de escopo (decidido com o autor): criar serviço separado de worker
(hoje `RUN_CONSUMERS_IN_API=true`), criar `postgres-exporter`/`redis-exporter`,
trocar credenciais do RabbitMQ, preencher `OPS_GRAFANA_*`.

---

## Mudanças

Branch novo a partir de `main`: `feat/alloy-no-railway`.
Um commit por mudança lógica, mensagem em português explicando o **porquê**.

### Commit 1 — `Dockerfile.alloy` na raiz

Segue o padrão do [Dockerfile.ai-agent](../Dockerfile.ai-agent) já existente
(raiz + contexto de build no repo inteiro), o que mantém a configuração do
Railway uniforme entre os serviços.

```dockerfile
FROM grafana/alloy:v1.19.2
COPY infra/observability/alloy/config.alloy /etc/alloy/config.alloy
```

A imagem oficial já tem `ENTRYPOINT ["/bin/alloy"]` e
`CMD ["run", "/etc/alloy/config.alloy", "--storage.path=/var/lib/alloy/data"]`,
então o `COPY` sozinho basta — repetir o `CMD` só criaria uma cópia para
divergir na próxima atualização de versão. Comentários no arquivo devem explicar:
a versão pinada (mesma do `check.mjs` e do compose local — validar com uma e
rodar com outra é como não validar), por que o config vai **dentro** da imagem, e
que o `storage.path` é o WAL do `remote_write` (sem volume no Railway, um restart
perde o que não foi enviado — aceitável, e é o mesmo trade-off do free tier).

### Commit 2 — alvos reais em `config.alloy`

[infra/observability/alloy/config.alloy](../infra/observability/alloy/config.alloy),
blocos `prometheus.scrape "aplicacoes"` e `"infraestrutura"`.

| Antes                                                 | Depois                                            |
| ----------------------------------------------------- | ------------------------------------------------- |
| `api.railway.internal:3001`                           | `financial-vellun-api.railway.internal:3001`      |
| `ai-agent-web.railway.internal:8010`                  | `financial-vellun-ai-agent.railway.internal:8010` |
| `ai-agent-worker.railway.internal:8011`               | comentado, com explicação                         |
| `postgres-exporter...:9187`, `redis-exporter...:9121` | comentados                                        |

- **worker**: comentado (não removido) com nota de que só existe quando
  `RUN_CONSUMERS_IN_API=false` e o worker roda em serviço próprio; hoje os
  consumers rodam no mesmo processo do webhook e suas métricas já saem em
  `job="ai-agent"`.
- **exporters**: comentados porque os serviços não existem. Se ficassem, `up`
  existiria valendo 0 e `InfraestruturaIndisponivel` (critical) dispararia para
  sempre — alerta que dispara sempre é alerta que vira silenciado. Comentado, o
  job simplesmente não existe e ninguém é acordado. Nota apontando para
  `docker-compose.observability.yml`, que tem as imagens pinadas quando forem
  criados.
- **rabbitmq** fica (`rabbitmq.railway.internal:15692`), com comentário de que o
  nome precisa bater com o do serviço no Railway e que a porta 15692 exige o
  plugin `rabbitmq_prometheus` habilitado — sem ele, `up{job="rabbitmq"}` fica 0
  e `InfraestruturaIndisponivel` dispara.

**Correção junto, necessária para funcionar**: `loki.source.api` escuta em
`0.0.0.0`, que é só IPv4. A rede privada do Railway é IPv6 (ambientes anteriores
a 2025-10-16 são só-IPv6; os novos são dual-stack), então API e agente não
conseguiriam entregar log em `alloy.railway.internal:3100`. Trocar para `::`, com
comentário explicando. **Só no `config.alloy`** — o `.local` continua em
`0.0.0.0`, que é o certo para o compose.

### Commit 3 — alertas que não exigem um serviço inexistente

[infra/observability/alerts/plataforma.yaml](../infra/observability/alerts/plataforma.yaml)

- `AusenciaInesperadaDeDados`: remover `or absent(up{job="ai-agent-worker"})`.
  Este é o que quebra — `absent()` dispara justamente quando a série nunca
  existe, que é o caso permanente aqui.
- `ServicoIndisponivel`: **manter** `ai-agent-worker` na alternância
  `up{job=~"api|ai-agent|ai-agent-worker"} == 0`, acrescentando comentário de que
  `up == 0` só dispara se a série existir — logo a alternância é inerte na
  topologia atual e passa a cobrir o worker sozinha se ele virar serviço próprio.

Testes em
[alerts/tests/plataforma.test.yaml](../infra/observability/alerts/tests/plataforma.test.yaml):

- caso "todos os alvos presentes não alerta ausencia": remover a série
  `up{job="ai-agent-worker"}`;
- caso "alvo que nunca aparece dispara ausencia de dados": o cenário usava o
  worker ausente. Trocar o alvo ausente para `ai-agent` (remover a série
  `up{job="ai-agent"}` da entrada e esperar `job: ai-agent`), atualizando o
  comentário. O caso continua provando a mesma coisa — `up == 0` fica calado
  quando a série nem existe, e é `absent()` que cobre esse silêncio.

[whatsapp-pipeline.yaml](../infra/observability/alerts/whatsapp-pipeline.yaml)
**não muda**: suas expressões não filtram por `job`; o `ai-agent-worker` aparece
lá só como label `service:` de roteamento de notificação.

### Commit 4 — agente ouvindo em `::` (DESCARTADO na implementação)

> **Não implementado.** A premissa estava errada: o `asyncio` liga `IPV6_V6ONLY`
> em todo socket IPv6, então `uvicorn --host ::` é **só IPv6** e recusaria o
> webhook público por IPv4. Conferido subindo a imagem: `[::1]` responde,
> `127.0.0.1` não. O agente segue em `0.0.0.0`, que basta num ambiente
> dual-stack do Railway; o ponto ficou registrado em `docs/observability.md`.
> O texto abaixo é o plano original.

[Dockerfile.ai-agent](../Dockerfile.ai-agent): `--host 0.0.0.0` → `--host ::`,
com comentário em português. Sem isso o Alloy pode nunca conseguir scrapar
`financial-vellun-ai-agent.railway.internal:8010`. No Linux o socket IPv6 também
aceita IPv4 (`bindv6only=0`), então o webhook público continua igual. A API não
precisa de mudança: `app.listen(port)` sem host
([apps/api/src/main.ts](../apps/api/src/main.ts)) já sobe dual-stack no Node.

### Commit 5 — documentação

[docs/observability.md](observability.md):

- seção nova **"Subir o Alloy no Railway"** com: o `Dockerfile.alloy`, os nomes
  reais dos serviços, a exigência de `PORT=3001` na API e `PORT=8010` no agente
  (o Alloy scrapa porta fixa; se o Railway atribuir outra, o alvo fica `down`), e
  a **ordem**: criar o Alloy com as variáveis → conferir os alvos `up` → só então
  preencher `LOKI_PUSH_URL` na API e no agente (antes disso o push falharia
  contra nada);
- ajustar o diagrama e a tabela de cardinalidade para refletir que
  `ai-agent-worker` não é um job nesta topologia — a linha vira nota, não some,
  porque a medição continua válida quando o worker for separado;
- registrar por que os exporters estão comentados e a nota do IPv6;
- atualizar "O que ainda depende de conta e painel": o item "montando
  `config.alloy`" já não descreve o que fazemos.

[README.md](../README.md), seção `### 5. Observabilidade`: hoje ela só fala de
`/health` e `/metrics` e termina dizendo que exportar para Prometheus está "fora
do escopo do MVP", o que ficou desatualizado. Atualizar em poucas linhas, com
ponteiro para `docs/observability.md` — sem duplicar o passo a passo.

[infra/observability/README.md](../infra/observability/README.md): acrescentar
`Dockerfile.alloy` ao mapa de arquivos.

---

## Verificação (antes de commitar)

```bash
# 1. Config válida — pega argumento inexistente e componente que não existe
docker run --rm -v "$PWD/infra/observability/alloy:/cfg" \
  grafana/alloy:v1.19.2 validate /cfg/config.alloy
docker run --rm -v "$PWD/infra/observability/alloy:/cfg" \
  grafana/alloy:v1.19.2 validate /cfg/config.alloy.local

# 2. A imagem nova constrói, e o config dentro dela é válido
docker build -f Dockerfile.alloy -t vellun-alloy:dev .
docker run --rm vellun-alloy:dev validate /etc/alloy/config.alloy

# 3. Alertas, dashboards e testes (roda 1 e mais três etapas)
pnpm obs:check
```

`pnpm obs:check` ([infra/observability/check.mjs](../infra/observability/check.mjs))
roda `alloy validate` nas duas configs, `promtool check rules`,
`promtool test rules` e o `promtool` sobre o PromQL dos dashboards. Os testes de
alerta precisam continuar passando — o caso reescrito de `absent()` é o único que
deve mudar de conteúdo.

Formatação: rodar Prettier **apenas nos arquivos tocados** (`prettier --write`
nos caminhos específicos), nunca `pnpm format` no repo inteiro. `.alloy` e
`Dockerfile*` não são formatados pelo Prettier; `.yaml`/`.md` são — conferir com
`git diff` que nenhum arquivo foi reformatado além das linhas da mudança.

Nada de `.env` nem segredo no diff: as credenciais do Grafana Cloud continuam só
nas variáveis do Railway.

---

## Depois do merge — passos manuais no Railway

1. **Criar o serviço `alloy`** a partir do repositório, com
   _Dockerfile Path_ = `Dockerfile.alloy`. Variáveis:
   `GRAFANA_CLOUD_PROM_URL`, `GRAFANA_CLOUD_PROM_USER`, `GRAFANA_CLOUD_LOKI_URL`,
   `GRAFANA_CLOUD_LOKI_USER`, `GRAFANA_CLOUD_TOKEN`, `METRICS_TOKEN` (o **mesmo**
   da API e do agente) e `ENVIRONMENT=production`. **Sem domínio público** — quem
   alcança a 3100 injeta linha de log, e a 12345 é a UI de diagnóstico.
2. **Fixar as portas**: `PORT=3001` na API e `PORT=8010` no agente, porque o
   Alloy scrapa porta fixa. Redeploy dos dois.
3. **Conferir os alvos** antes de mexer em log: nos logs do Alloy, ou pelo
   Grafana Cloud, `up{job="api"}` e `up{job="ai-agent"}` valendo 1.
4. **Só então** `LOKI_PUSH_URL=http://alloy.railway.internal:3100` na API e no
   agente, e redeploy.
5. Se `up{job="rabbitmq"}` ficar 0: o plugin `rabbitmq_prometheus` (porta 15692)
   não está habilitado no serviço do RabbitMQ, ou o nome interno dele não é
   `rabbitmq`.

## Pendências conhecidas, fora deste PR

- trocar as credenciais do RabbitMQ (foram expostas num chat);
- criar `postgres-exporter` e `redis-exporter`, se quisermos os painéis de banco
  e cache — e então descomentar os alvos em `config.alloy`;
- preencher `OPS_GRAFANA_URL` e `OPS_GRAFANA_LOKI_DATASOURCE_UID` na API, para os
  atalhos do Grafana aparecerem no painel `/ops`.
