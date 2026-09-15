# 0010 — Consumers no lifespan da API e worker separado

- **Status:** Aceito
- **Data:** 2026-09-05

## Contexto

Os consumers precisam de um processo que os hospede. Rodar dentro da API
simplifica o desenvolvimento (um comando só), mas amarra a escala do
processamento à escala da camada HTTP: um pico de chamadas à OpenAI passa a
competir com o ack do webhook. Rodar apenas como worker separado é mais limpo em
produção, ao custo de atrito diário no desenvolvimento.

## Decisão

Suportar as duas topologias, escolhidas por `RUN_CONSUMERS_IN_API`:

- `true` (**padrão**) — o `lifespan` da API sobe publisher, os dois consumers e
  o worker de agrupamento. Um comando, ideal para desenvolvimento e para cargas
  pequenas;
- `false` — a API só publica; o consumo roda em `python -m src.worker`
  (`pnpm agent:worker`), escalável de forma independente.

O publisher sobe **sempre**, em qualquer modo: sem ele o webhook não consegue
responder `202`.

Um único objeto (`src/bootstrap.py::pipeline`) monta e desmonta tudo, usado
pelos dois entrypoints. O **shutdown gracioso** segue esta ordem:

1. o worker de agrupamento para de consolidar novos grupos;
2. os consumers cancelam o consumo (param de receber), aguardam o que está em
   voo até `SHUTDOWN_DRAIN_SECONDS` e devolvem (`nack requeue`) o que não
   terminou;
3. conexões HTTP, Redis e broker são fechadas.

**Health checks** separados: `/health/live` (o processo está de pé, sem
dependência externa) e `/health/ready` (consegue publicar e consumir, e o Redis
responde). O readiness falha com `503` quando o broker está fora, para o
orquestrador tirar a instância do balanceador em vez de aceitar webhooks que não
poderiam ser publicados. `/health` continua existindo como alias de liveness.

## Consequências

**Ganhos**

- `pnpm dev` continua subindo tudo com um comando.
- Em produção, processamento e recepção escalam separadamente.
- Nenhuma mensagem confirmada se perde num deploy: o que não terminou volta
  para a fila.
- O balanceador para de mandar tráfego para uma instância que não pode publicar.

**Custos**

- Dois entrypoints para manter em sintonia (ambos delegam a `bootstrap`, o que
  reduz o risco).
- Com `RUN_CONSUMERS_IN_API=true` e várias réplicas da API, cada réplica também
  consome — desejável, mas é preciso ter isso em conta ao dimensionar o
  `PROCESSING_CONSUMER_CONCURRENCY`.

## Alternativas consideradas

- **Só no lifespan.** Mais simples, mas escalar consumo obrigaria a escalar a
  camada HTTP junto.
- **Só worker separado.** Mais limpo em produção, mas exigiria um segundo
  processo inclusive em desenvolvimento.
