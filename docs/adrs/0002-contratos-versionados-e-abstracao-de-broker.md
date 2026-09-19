# 0002 — Contratos versionados e abstração do broker

- **Status:** Aceito
- **Data:** 2026-09-05

## Contexto

Adotar RabbitMQ ([0001](0001-broker-duravel-rabbitmq.md)) não pode significar
espalhar `aio_pika` pelo domínio. Um dia o broker pode virar SQS, Kafka ou
Redis Streams, e a troca precisa ser localizada. Além disso, produtor e
consumidor sobem em deploys diferentes: durante um rollout, a versão nova
publica enquanto a antiga ainda consome.

## Decisão

**Abstração.** Todo acesso ao broker passa por `src/messaging/base.py`:
`MessagePublisher`, `MessageConsumer`, `BrokerMessage` e a política única
`dispatch()`. O driver concreto vive em `src/messaging/rabbitmq/`; existe também
um driver `inmemory` usado em testes e em desenvolvimento sem Docker. O domínio
(consumers, agrupamento, processador) nunca importa `aio_pika`.

**Contratos.** Os payloads são modelos Pydantic em `src/messaging/contracts.py`,
serializados em JSON com chaves `camelCase` e campo `schemaVersion` obrigatório:

- `InboundMessageV1` — uma mensagem recebida, já normalizada;
- `ProcessingJobV1` — mensagens consolidadas por telefone;
- `DlqEnvelopeV1` — o que é gravado na DLQ.

Regras que valem para todos:

- validados **antes** de publicar e **de novo** no consumer;
- `extra="forbid"`: campo desconhecido é erro, não é silenciosamente ignorado;
- `correlationId` em todos, para correlacionar logs ponta a ponta;
- mídia viaja como **referência** (`mediaId`/`mediaMime`), nunca binário;
- telefone sempre normalizado em E.164, pelo mesmo algoritmo da API
  (`src/services/phone.py` espelha `apps/api/src/common/phone.util.ts`).

Um payload que não valida é falha **permanente**: vai direto para a DLQ, sem
retry — reprocessar não vai fazê-lo passar a validar.

## Consequências

**Ganhos**

- Trocar de broker é adicionar um driver em `messaging/` e apontar
  `MESSAGE_BROKER`, sem tocar em domínio.
- A política de ack/retry/DLQ é uma só (`dispatch`), compartilhada pelos
  drivers: o comportamento testado em memória é o mesmo em produção.
- `schemaVersion` torna explícita a incompatibilidade em vez de produzir dados
  silenciosamente errados.

**Custos**

- Uma camada a mais entre o domínio e a biblioteca.
- Evoluir o contrato exige disciplina: campo novo precisa ser opcional, ou a
  versão precisa subir e o consumer aceitar as duas por um período.

## Alternativas consideradas

- **Usar `aio_pika.IncomingMessage` diretamente nos handlers.** Menos código,
  mas amarra o domínio à biblioteca e torna o teste dependente do broker real.
- **Payload livre (`dict`).** Rejeitada: erro de contrato só apareceria como
  `KeyError` em produção, no meio do processamento, depois do ack.
