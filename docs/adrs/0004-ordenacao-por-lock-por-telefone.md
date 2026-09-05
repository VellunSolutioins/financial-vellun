# 0004 — Ordenação por lock distribuído por telefone

- **Status:** Aceito
- **Data:** 2026-09-05

## Contexto

Com vários consumers, mensagens do mesmo telefone podem ser processadas em
paralelo. Isso quebraria o diálogo de três formas concretas:

- a resposta "sim" ser processada antes da pergunta de confirmação;
- dois intents pendentes se sobrescreverem no estado de conversa;
- dois lançamentos serem criados fora de ordem.

Telefones **diferentes**, por outro lado, devem correr em paralelo — é onde
está o ganho de escala.

## Decisão

Lock distribuído por telefone durante todo o processamento do job:
`proc:lock:{phone}` no Redis, com `SET NX PX` e TTL
(`PROCESSING_LOCK_TTL_SECONDS`, 120 s por padrão) para nunca travar para sempre.

Quando um job chega e o telefone está ocupado, ele **não** falha: levanta
`DeferError`, que reagenda a mensagem no menor bucket de retry (1 s) **sem
consumir tentativa**. Adiar por concorrência não é falha e não pode empurrar
uma mensagem legítima para a DLQ.

Para que o adiamento não vire laço infinito (por exemplo, um lock preso por um
defeito), o header `x-defer-count` conta os adiamentos; passando de `MAX_DEFERS`
(60), o job passa a ser tratado como falha e caminha para a DLQ.

## Consequências

**Ganhos**

- Telefones diferentes são processados em paralelo, limitados por
  `PROCESSING_CONSUMER_CONCURRENCY`.
- O mesmo telefone é serializado, mesmo com N consumers em N máquinas.
- O adiamento não gasta tentativas nem enche a DLQ de falsos positivos.

**Custos**

- Um ida-e-volta ao Redis por job.
- A ordenação é _lógica_, não FIFO estrita: se o primeiro job de um telefone
  falhar e for para o retry, um job posterior pode ser processado antes dele.
  O estado de conversa ([0008](0008-estado-de-conversa-distribuido.md)) é o que
  garante a coerência do diálogo nesse caso.
- Um job adiado consome uma volta na fila de retry de 1 s.

## Alternativas consideradas

- **Particionamento consistente por telefone** (exchange `consistent-hash` do
  RabbitMQ, uma fila por partição). Daria FIFO estrito por telefone, mas exige
  um plugin, fixa o número de partições e complica o rebalanceamento ao escalar.
- **Confiar na ordem global da fila com um único consumer.** Simples, mas anula
  a escala horizontal, que é justamente o objetivo.
- **Serializar tudo por um lock global.** Correto e inútil: serializaria também
  telefones sem nenhuma relação entre si.
