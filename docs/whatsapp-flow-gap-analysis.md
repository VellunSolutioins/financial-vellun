# Fluxo do WhatsApp: análise de gaps e plano de correção

> Escrito para quem mantém o pipeline `webhook → RabbitMQ → consumers → resposta`.
> Complementa o [runbook operacional](whatsapp-messaging-runbook.md), que descreve o fluxo
> como ele **deveria** operar. Este documento descreve como ele **está**.

## Contexto

Uma mensagem enviada pelo WhatsApp em **produção (Railway)** para criar um lançamento
resultou em:

- webhook respondeu `202`;
- **nenhum lançamento foi criado**;
- **nenhuma resposta chegou ao usuário**.

O `202` prova que o *publisher confirm* do RabbitMQ voltou — a mensagem **entrou** em
`whatsapp.inbound.v1`. Logo o defeito está depois da publicação. O problema real é que
**hoje não dá para saber onde**: o pipeline tem vários pontos que reportam sucesso sem
entregar nada, e no Railway o Alloy ainda não existe
([plano](alloy-no-railway-plan.md)), então os logs dos consumers não são consultáveis.

---

## O fluxo real

O comportamento esperado é descrito em 5 passos (chega → processa mínimo → publica →
`202` → consumer executa → responde). No código são **5 saltos, 2 filas e 1 timer**:

```
POST /webhook/whatsapp                       routers/webhook.py:127
  valida assinatura → parse_inbound → to_contract → publish_many(ROUTE_INBOUND)
  └─ 202 só após publisher confirm                                    ✔ comprovado

[fila whatsapp.inbound.v1]
InboundMessageConsumer.handle                consumers/inbound_consumer.py:86
  ├─ _persist_inbound → POST /internal/ai-events na API NestJS   (falha ⇒ TransientError)
  └─ store.append(phone, GroupEntry) → Redis  (group:{phone}, group:due)
     ACK AQUI — a mensagem some do RabbitMQ e vira estado no Redis

[timer, 1s]  GroupFlusherWorker.tick          grouping/flusher.py:103
  debounce 5s / máx 10 msgs / teto 30s → build_job → publish(ROUTE_PROCESSING)

[fila whatsapp.processing.v1]
MessageProcessingConsumer.handle             consumers/processing_consumer.py:61
  dedupe job:done → lock proc:lock:{phone} → message_processor.process_job

MessageProcessor._process                    services/message_processor.py:82
  contact_service.find_by_phone → subscription_gate → contexto → LLM
  → transaction_creator.create_from_intent → respond() → messenger.send()
```

Detalhe estrutural que muda o diagnóstico: **o consumer de entrada não publica o job**.
Ele persiste na API, escreve no Redis e acka. Quem publica é o `GroupFlusherWorker`, um
`asyncio.create_task` criado **apenas** dentro de `pipeline.start_consumers()`
(`bootstrap.py:69`).

### Esperado × real

| Passo esperado | Real |
| --- | --- |
| Mensagem chega no endpoint | ✔ igual |
| Processamento mínimo | ✔ igual — valida assinatura, normaliza, monta o contrato |
| Processo enviado ao RabbitMQ | ✔ igual — `publish_many` em `whatsapp.inbound.v1` |
| Endpoint responde `202` | ✔ igual — só após o *publisher confirm* |
| Consumer executa o processo | ✘ **dois** consumers, com um timer e o Redis entre eles |
| Resposta enviada ao usuário | ✘ o envio pode falhar em silêncio e ainda assim marcar o job como concluído |

---

## Gaps

### G1 — O envio ao WhatsApp falha em silêncio

Explica "nunca houve mensagem de resposta". São três camadas empilhadas, todas silenciosas:

1. `services/messenger/factory.py:26-35` — provider ausente, desconhecido, ou
   `WHATSAPP_PROVIDER_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` faltando ⇒ `logger.warning` +
   **`LogMessenger`**. O serviço sobe verde. O default de `WHATSAPP_PROVIDER` é `"log"`
   (`config.py:33`), então **esquecer a variável no Railway já basta** para nenhuma
   mensagem sair.
2. `services/messenger/cloud_api_messenger.py:45-57` — erro de rede ⇒ `logger.exception` +
   `return`; status ≠ 200/201 (token expirado, número inválido, janela de 24h) ⇒ apenas
   `logger.warning`. **Nunca levanta.**
3. Consequência: `respond()` "conclui", `process_job` retorna, e
   `consumers/processing_consumer.py:138` marca `job:done:{jobId}` por **24h**
   (`JOB_DEDUPE_TTL_SECONDS`). O reprocessamento manual do job vira no-op por um dia inteiro.

O contador `whatsapp_send_failed` existe, mas só é incrementado quando `messenger.send`
levanta — o que o Cloud API nunca faz. Ele é estruturalmente zero.

### G2 — Texto depende da API principal antes de ser agrupado

`_persist_inbound` (`consumers/inbound_consumer.py:234`) é obrigatório no caminho de texto.
Se `MAIN_API_URL` ou `INTERNAL_API_KEY` estiverem errados no Railway (ou a API estiver
fora) ⇒ `TransientError` ⇒ 5 retries ⇒ **DLQ**. Lançamento não criado, usuário sem
resposta. Também casa com o sintoma observado.

### G3 — DLQ não avisa ninguém

Quando um job esgota as tentativas, a mensagem vai para `whatsapp.*.dlq` e é **ackada**.
Não existe nenhum caminho que responda "não consegui registrar, tente de novo". O usuário
fica em silêncio permanente — exatamente o comportamento observado.

### G4 — Contato não vinculado é indistinguível de falha

`contact_service.find_by_phone` (`services/contact_service.py:18-28`) devolve `None` tanto
para 404 (não vinculado) quanto para erro de rede ou status inesperado. Nos dois casos
responde `NOT_LINKED_MESSAGE` — que, com G1 ativo, o usuário nunca vê.

### G5 — Cegueira em produção

`LOKI_PUSH_URL` está vazio no Railway e não há Alloy, então **nenhum log de consumer é
consultável** e os quatro dashboards estão vazios. É por isso que a investigação para no
`202`. Plano já escrito em [`alloy-no-railway-plan.md`](alloy-no-railway-plan.md).

### G6 — Menores

- `pipeline.readiness()` (`bootstrap.py:148`) não cobre o `GroupFlusherWorker`. Sem o
  flusher, o texto fica preso no Redis para sempre — sem fila crescendo e sem DLQ acendendo.
- `bootstrap.py:105-106` usa `return` onde deveria ser `continue` (inofensivo hoje, porque
  só ocorre no driver `inmemory`).
- **Não existe teste end-to-end** webhook → fila → consumers → resposta. A cobertura é por
  camada, com dublês nas fronteiras — exatamente onde o defeito está.

---

## Roteiro de diagnóstico

O caminho mais rápido é **um único scrape de métricas**, não o Loki. Os contadores são
pré-declarados (`services/metrics.py:63-104`), então zero é informação, não ausência.

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" https://<agente>/metrics.json
```

| Último contador > 0 | Onde parou |
| --- | --- |
| `publish_confirmed` | não consumiu → consumer não está de pé (`RUN_CONSUMERS_IN_API`) |
| `messages_consumed` | morreu no `_persist_inbound` (G2) → conferir DLQ |
| `inbound_grouped` | flusher não rodou / Redis fora (G6) |
| `jobs_published` | processing consumer parado ou lock preso |
| `jobs_processed` sem `transactions_created` | `not_linked` / `subscription_blocked` / confirmação pendente |
| `transactions_created` > 0 e nada chegou | **G1** — messenger em modo `log` ou Graph recusando |

Apoio, na ordem:

1. **`/ops/falhas`** — o catálogo de DLQ já drena para `ops_failed_messages`; o envelope
   traz fila de origem, `errorType`, `errorMessage` e `attempts`.
2. **RabbitMQ Management** — profundidade de `whatsapp.inbound.v1`,
   `whatsapp.processing.v1` e as duas `.dlq`. Tudo zerado + nenhum lançamento ⇒ a mensagem
   foi "processada com sucesso" ⇒ G1.
3. **Redis** — `LLEN group:{phone}` e `ZSCORE group:due {phone}`. Entrada parada ali ⇒
   flusher morto.
4. **Variáveis do Railway** — `WHATSAPP_PROVIDER`, `WHATSAPP_PROVIDER_TOKEN`,
   `WHATSAPP_PHONE_NUMBER_ID`, `MAIN_API_URL`, `INTERNAL_API_KEY` (idêntica à da API),
   `REDIS_URL`, `RUN_CONSUMERS_IN_API`.

---

## Correções

> **Status: implementadas** (G1, G2 via G3, G3, G4, G6). G5 segue no plano do Alloy.
> Os testes novos estão em `test_messenger.py`, `test_contact_service.py`,
> `test_pipeline_end_to_end.py` e nas seções novas de `test_processing_consumer.py`
> e `test_dlq_catalog_consumer.py`.

### Passo 1 — Fechar o silêncio do messenger (G1)

- `messenger/factory.py`: em `settings.is_production`, **levantar** em vez de cair para
  `LogMessenger` (provider desconhecido, config do Cloud API inválida, ou provider `log`
  explícito). Em desenvolvimento, manter o fallback.
- `cloud_api_messenger.send`: **levantar** — `TransientError` para rede/5xx/429,
  `PermanentError` para 4xx de negócio — em vez de `return` silencioso. Com isso
  `whatsapp_send_failed` passa a valer alguma coisa.
- **Achado na implementação:** levantar no envio *não* era seguro como estava. O retry
  refazia o job inteiro, e a criação do lançamento é idempotente, mas a confirmação
  pendente não: ao criar, `conversation_manager.clear()` já a consumiu, e o "sim"
  reprocessado era classificado do zero, sem a pergunta que ele responde. Por isso
  **calcular e entregar foram separados**: `process_job` devolve o texto,
  o consumer o guarda em `job:reply:{jobId}` e só então chama `deliver`. O retry de
  uma entrega que falhou reenvia o texto guardado (`jobs_reply_resumed`), e `job:done`
  só é marcado depois da entrega. Coberto por
  `test_confirmacao_nao_e_reclassificada_quando_so_o_envio_falha`, que falha com o
  comportamento antigo.
- `POST /internal/notifications/welcome` responde `502` quando a entrega falha
  (a API já trata não-2xx como best-effort).
- Log de arranque declarando a configuração efetiva: messenger resolvido, `LLM_PROVIDER`,
  `MAIN_API_URL`, `GROUP_STORE_BACKEND`, `RUN_CONSUMERS_IN_API`. Hoje é impossível saber
  pelos logs que o agente está em modo `log`.

### Passo 2 — Rede de segurança da DLQ (G3)

No `DlqCatalogMessageConsumer` (`consumers/dlq_catalog_consumer.py`), que já recebe o
envelope com o `phone`: após catalogar, enviar **uma** mensagem de desculpa ao usuário.
Guardar com uma chave Redis curta (`dlq:notified:{phone}`) para não inundar em incidente.
Isso transforma "silêncio" em "erro visível".

Implementado com `DLQ_USER_NOTICE_COOLDOWN_SECONDS` (padrão 600; `0` desliga). A janela é
marcada **antes** do envio — se o WhatsApp for a causa, cada falha não seguraria o
consumer no timeout. O texto não afirma que nada foi registrado, porque a falha pode ter
vindo depois de o lançamento ser criado.

### Passo 3 — Distinguir 404 de falha (G4) e readiness do flusher (G6)

- `contact_service.find_by_phone`: separar "não vinculado" (404) de "não consegui
  perguntar" (rede/5xx) — o segundo deve virar `TransientError` e retentar, não responder
  `NOT_LINKED_MESSAGE`.
- `pipeline.readiness()`: incluir `flusher.is_running()` quando os consumers estão ativos.
- `bootstrap.py:105-106`: `return` → `continue`.

### Passo 4 — Teste end-to-end

`apps/ai-agent/tests/test_pipeline_end_to_end.py`: broker `inmemory` + group store
`memory`, `pipeline.start_consumers()` real, `TestClient` postando um webhook de texto,
`drain()`, e asserção de que um dublê de `Messenger` recebeu a resposta e o lançamento foi
criado. Reaproveitar os fixtures de `tests/conftest.py`.

### Pendências

- **Integração:** `pytest -m integration` não rodou nesta implementação (RabbitMQ e Redis
  fora do ar). Os métodos novos `put`/`get` do `RedisStateStore` só foram exercitados via
  dublê em memória.
- **Alertas:** `whatsapp_send_failed` e `dlq_user_notified` ainda não têm regra em
  `infra/observability/alerts/`.

### Fora de escopo aqui

Subir o Alloy no Railway — já planejado em [`alloy-no-railway-plan.md`](alloy-no-railway-plan.md).
Sem ele o G5 permanece, mas o Passo 1 já torna o defeito visível pelos logs do próprio Railway.

---

## Verificação

1. `cd apps/ai-agent && .venv\Scripts\python.exe -m pytest -q` — inclui o novo e2e.
2. `.venv\Scripts\python.exe -m pytest -m integration -q` com `pnpm db:up` — topologia real.
3. Local com `pnpm dev`: enviar um webhook simulado e conferir a sequência de contadores em
   `http://localhost:8010/metrics.json` até `transactions_created`.
4. Com `WHATSAPP_PROVIDER` ausente e `ENVIRONMENT=production`, o agente deve **falhar ao
   subir** — é a prova do Passo 1.
5. Forçar uma falha permanente (ex.: `MAIN_API_URL` inválida) e confirmar que a mensagem
   chega em `/ops/falhas` **e** que o usuário recebe o aviso do Passo 2.
