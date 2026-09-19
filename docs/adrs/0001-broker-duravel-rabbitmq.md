# 0001 — RabbitMQ como broker durável do pipeline WhatsApp

- **Status:** Aceito
- **Data:** 2026-09-05

## Contexto

O `POST /webhook/whatsapp` fazia trabalho demais dentro do ciclo HTTP: além de
validar a assinatura, chamava a API principal para persistir a mensagem inbound
e disparava `asyncio.create_task` para áudio e imagem. Três consequências:

- o ack para a Meta dependia de a API principal estar de pé;
- qualquer restart perdia o que estava em voo (tasks locais e buffer em memória);
- não havia como escalar o processamento sem escalar também a camada HTTP.

O projeto **não tinha broker algum**: o `docker-compose` só subia PostgreSQL, e
não havia nenhuma ocorrência de `rabbitmq`, `amqp`, `celery`, `kafka` ou `sqs`.
Existia um buffer caseiro opcional em Redis (`redis_buffer.py`), mas Redis nunca
foi provisionado e o mecanismo não oferecia entrega durável nem DLQ observável.

## Decisão

Adotar **RabbitMQ** como broker inicial, provisionado no `docker-compose` junto
com **Redis** (que passa a cuidar de agrupamento, locks e estado de conversa).

O webhook passa a fazer apenas: ler o corpo bruto, validar a assinatura,
normalizar o payload, publicar cada mensagem em `whatsapp.inbound.v1` e
responder `202 Accepted` **depois** do _publisher confirm_. Se a publicação não
puder ser garantida, responde `503`.

Todas as filas e exchanges são declaradas `durable`, as mensagens são publicadas
como `PERSISTENT`, e o consumo usa ack manual com `prefetch` configurável.

## Consequências

**Ganhos**

- O ack ao provedor deixa de depender da API principal, do banco e da OpenAI.
- Mensagens confirmadas sobrevivem a restart e deploy.
- Consumers escalam horizontalmente, independentemente da camada HTTP.
- Retry e DLQ passam a ser observáveis no painel do RabbitMQ (`:15672`).

**Custos**

- Dois containers novos no ambiente local. Mitigado por
  `MESSAGE_BROKER=inmemory` + `GROUP_STORE_BACKEND=memory`, que rodam o pipeline
  inteiro em um processo, sem Docker (sem durabilidade — só desenvolvimento).
- Uma dependência nova (`aio-pika`) e uma operação a mais para manter.
- O caminho fica mais longo: a latência entre receber e processar cresce pelo
  hop na fila. Medida em `receive_to_process_ms`.

## Alternativas consideradas

- **Manter o buffer Redis existente.** Rejeitada: não há entrega durável com
  ack, retry é um laço em memória do worker, e a "DLQ" é uma lista sem
  ferramenta de inspeção ou reprocesso.
- **Redis Streams com consumer groups.** Seria um container a menos, mas exige
  implementar à mão o que o RabbitMQ já oferece pronto: dead-lettering, filas de
  atraso, prefetch, painel de inspeção e reprocesso.
- **Fila no PostgreSQL (`SELECT ... FOR UPDATE SKIP LOCKED`).** Zero
  infraestrutura nova, mas coloca a carga de polling no banco transacional do
  produto e não oferece atraso nativo para retry.
