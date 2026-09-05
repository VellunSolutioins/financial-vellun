# Architecture Decision Records (ADRs)

Registro das decisões arquiteturais relevantes do Financial Vellun: **o que** foi
decidido, **por quê**, e o que se ganha e se perde com isso. Um ADR não é
documentação de uso — é o histórico de por que o sistema é como é, para que uma
decisão não seja revertida sem que o contexto original seja considerado.

## Convenções

- Arquivos `NNNN-titulo-em-kebab-case.md`, numeração sequencial.
- Estrutura: **Contexto → Decisão → Consequências → Alternativas consideradas**.
- Status: `Proposto`, `Aceito`, `Substituído por NNNN`, `Descontinuado`.
- Um ADR aceito **não é editado** quando a decisão muda: cria-se outro que o
  substitui, e o antigo passa a apontar para o novo.

## Índice

| ADR                                                         | Título                                              | Status |
| ----------------------------------------------------------- | --------------------------------------------------- | ------ |
| [0001](0001-broker-duravel-rabbitmq.md)                     | RabbitMQ como broker durável do pipeline WhatsApp   | Aceito |
| [0002](0002-contratos-versionados-e-abstracao-de-broker.md) | Contratos versionados e abstração do broker         | Aceito |
| [0003](0003-agrupamento-distribuido-em-redis.md)            | Agrupamento (debounce) distribuído em Redis         | Aceito |
| [0004](0004-ordenacao-por-lock-por-telefone.md)             | Ordenação por lock distribuído por telefone         | Aceito |
| [0005](0005-idempotencia-em-tres-niveis.md)                 | Idempotência em três níveis                         | Aceito |
| [0006](0006-retry-por-buckets-e-dlq.md)                     | Retry por buckets de TTL e dead-letter queues       | Aceito |
| [0007](0007-audio-agrupa-imagem-job-proprio.md)             | Áudio entra no agrupamento; imagem vira job próprio | Aceito |
| [0008](0008-estado-de-conversa-distribuido.md)              | Estado de conversa distribuído e versionado         | Aceito |
| [0009](0009-rollout-por-flag-message-pipeline.md)           | Rollout por flag `MESSAGE_PIPELINE`                 | Aceito |
| [0010](0010-topologia-de-processos.md)                      | Consumers no lifespan da API e worker separado      | Aceito |
