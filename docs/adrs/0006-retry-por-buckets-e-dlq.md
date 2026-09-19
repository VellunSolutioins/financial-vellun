# 0006 — Retry por buckets de TTL e dead-letter queues

- **Status:** Aceito
- **Data:** 2026-09-05

## Contexto

Falhas transitórias (API principal fora, timeout, rate limit da OpenAI,
indisponibilidade do WhatsApp) devem ser retentadas com backoff. Falhas
permanentes (contrato inválido, tipo não suportado) não devem ser retentadas —
tentar de novo não muda o resultado, só gasta recurso e atrasa a fila.

O RabbitMQ não tem atraso nativo de mensagem. A abordagem comum é TTL por
mensagem numa fila de retry, mas isso causa _head-of-line blocking_: a fila só
expira a mensagem da cabeça, então uma mensagem com TTL de 300 s segura todas
as de TTL menor atrás dela.

## Decisão

**Buckets de TTL fixo.** Cinco filas de retry por fila principal, com
`x-message-ttl` de 1 s, 4 s, 16 s, 60 s e 300 s, cada uma com dead-letter de
volta à exchange principal. O bucket é escolhido pelo número da tentativa
(`min(base * 2^tentativa, máximo)`, arredondado para o bucket que o cobre). O
jitter é uma espera aleatória curta (< 1 s) antes de republicar, o suficiente
para desalinhar rajadas sem misturar TTLs numa mesma fila.

**Classificação de falhas** em `dispatch()`, uma única política compartilhada
por todos os drivers:

| Situação                             | Destino                                             |
| ------------------------------------ | --------------------------------------------------- |
| sucesso                              | `ack`                                               |
| `DeferError` (telefone ocupado)      | reagenda no bucket de 1 s, **sem** contar tentativa |
| `PermanentError` / contrato inválido | DLQ imediatamente                                   |
| qualquer outra exceção               | retry com backoff, até `MESSAGE_MAX_RETRIES`        |
| tentativas esgotadas                 | DLQ                                                 |

**DLQs** `whatsapp.inbound.dlq` e `whatsapp.processing.dlq`, ligadas a
`whatsapp.dlx`. O envelope (`DlqEnvelopeV1`) carrega payload original, fila de
origem, routing key, número de tentativas, tipo do erro, mensagem **sanitizada**
(truncada em 500 caracteres, sem payload financeiro), se foi falha permanente,
timestamps e `correlationId`.

Uma mensagem só recebe `ack` quando o efeito daquela etapa está duravelmente
concluído — ou quando a responsabilidade foi transferida (reagendada no retry ou
registrada na DLQ). Não há laço de retry infinito.

## Consequências

**Ganhos**

- Backoff exponencial sem head-of-line blocking.
- Falha permanente não gasta cinco tentativas antes de ir para a DLQ.
- A DLQ é inspecionável no painel do RabbitMQ e tem o necessário para
  diagnóstico e reprocesso.
- A política é a mesma em memória e em produção, então o teste vale.

**Custos**

- Dez filas de retry declaradas (cinco por fila principal), o que polui a
  listagem do painel.
- O backoff é granular só nos cinco degraus; um `MESSAGE_RETRY_BASE_SECONDS`
  muito fora dessa escala perde precisão.
- Republicar no retry e ackar o original significa que a mensagem muda de
  `delivery_tag` a cada tentativa; o rastro entre elas é o `correlationId`.

## Alternativas consideradas

- **TTL por mensagem numa fila única de retry.** Menos filas, mas o head-of-line
  blocking faria uma mensagem de backoff longo segurar as de backoff curto.
- **Plugin `rabbitmq_delayed_message_exchange`.** Resolve elegantemente, mas é
  plugin de terceiro, precisa estar instalado no broker e limita a portabilidade
  para um serviço gerenciado.
- **`nack(requeue=True)` com espera no consumer.** Simples e ruim: prende o
  worker durante o backoff e devolve a mensagem para a cabeça da fila,
  reprocessando em laço apertado.
