# Tuning e escala

Como escolher concorrência, réplicas e limites — e em que ordem mexer neles.
Referência: P6 do [plano de performance](../plan/plano-implementacao-performance.md).

A regra que organiza tudo:

```
réplicas × concorrência ≤ capacidade do downstream
```

Aumentar concorrência sem folga no downstream não acelera nada: só move a fila
de um lugar visível (o broker) para um lugar invisível (o pool de conexões, o
rate limit da Meta, o limite de requisições da OpenAI).

## Os quatro botões

| Botão                             | Onde   | Limita                            | Downstream que ele pressiona         |
| --------------------------------- | ------ | --------------------------------- | ------------------------------------ |
| `RABBITMQ_PREFETCH`               | agente | mensagens não-ackadas por conexão | memória do processo                  |
| `INBOUND_CONSUMER_CONCURRENCY`    | worker | mensagens de entrada em paralelo  | API principal, download de mídia     |
| `PROCESSING_CONSUMER_CONCURRENCY` | worker | jobs em paralelo                  | **OpenAI**, API principal → Postgres |
| `OUTBOUND_CONSUMER_CONCURRENCY`   | worker | entregas em paralelo              | **rate limit da Meta**               |

`RABBITMQ_PREFETCH` precisa ser **maior** que a soma das concorrências, senão o
consumer fica sem mensagem em mãos enquanto processa — e a concorrência
configurada nunca é alcançada. Padrão atual: prefetch 10 para 5 + 3 + 3.

## A ordem de mexer

1. **Meça primeiro.** Os perfis do capacity review
   ([runbook](whatsapp-messaging-runbook.md#capacity-review)) dizem onde está o
   tempo: `receive_to_process`, `processing_duration`, `llm_latency`,
   `outbound_send`. Mexer sem isso é adivinhação cara.
2. **Escale em processos, não em concorrência.** O joelho do webhook fica entre
   10 e 25 requests simultâneos, porque as publicações disputam o mesmo canal
   AMQP à espera do _publisher confirm_. Mais réplicas resolvem; mais
   concorrência num processo só piora a latência.
3. **Worker por backlog, não por CPU.** O sinal certo é profundidade da fila e
   **idade da mensagem mais antiga** — o worker fica ocioso esperando I/O, então
   CPU baixa com fila crescendo é o caso normal, não uma contradição.
4. **API só depois do throttler em Redis** (contrato C11, já entregue) **e com o
   connection budget refeito**: `réplicas × connection_limit` precisa caber no
   `max_connections` contando a sobreposição do deploy. Ver
   [connection-budget.md](connection-budget.md).

## O que não adianta escalar

- **`jobs_deferred` alto** é contenção por telefone: as mensagens de um mesmo
  número são serializadas de propósito, para a confirmação nunca ser processada
  antes da pergunta. Mais réplicas disputam o mesmo lock e adiam mais.
- **Backlog só em `whatsapp.outbound.v1`** é a Meta, não nós. Mais entregas em
  paralelo contra um provedor recusando é como se acelera um `429` para um
  bloqueio mais longo.
- **Webhook lento com fila vazia** é o _publisher confirm_, que é a garantia que
  o `202` representa. Só melhora com mais réplicas ou um broker mais rápido.

## Redis não é cache

O que vive no Redis não tem segunda cópia: o lock que ordena as mensagens de um
telefone, a confirmação pendente que o usuário está respondendo, o buffer de
agrupamento, a marca de job concluído que impede lançamento duplicado.

Daí a configuração (ver `infra/docker/docker-compose.yml`):

- **`appendonly yes`** — o estado sobrevive a restart. Sem isso, um restart
  apagaria confirmações pendentes e marcas de idempotência, e uma reentrega
  criaria o lançamento de novo.
- **`maxmemory-policy noeviction`** — sob pressão de memória o Redis **recusa
  escrita** em vez de descartar uma chave. Escrita recusada é um erro alto, que
  vira retry e alerta; chave descartada em silêncio é um lock que some no meio
  de um job, e ninguém fica sabendo.

O alerta de memória (`plataforma.yaml`) dispara em 85% — com `noeviction`,
chegar a 100% é parar de aceitar escrita.

### Se o Redis for perdido

Não há recuperação transparente, e é melhor saber disso antes:

| O que se perde          | Efeito                                                     | O que fazer                        |
| ----------------------- | ---------------------------------------------------------- | ---------------------------------- |
| Locks de telefone       | nenhum — expiram sozinhos                                  | nada                               |
| Buffer de agrupamento   | mensagens recebidas e não consolidadas somem               | o usuário reenvia                  |
| Confirmações pendentes  | um "sim" fica sem pergunta; o bot trata como nova mensagem | nada; o usuário refaz o lançamento |
| `job:done` / `job:sent` | uma reentrega pode reprocessar ou reenviar                 | conferir duplicidade no período    |
| Rate limit da API       | contadores zeram                                           | nada                               |

Nenhum lançamento **já criado** se perde: eles estão no Postgres, e a chave de
idempotência também. O risco real da perda é duplicidade na janela de reentrega,
não perda de dado.

Com AOF e volume persistente, o cenário provável é restart (que preserva), não
perda. A perda total exige o volume ir junto — e aí o passo é subir um Redis
vazio e deixar o pipeline reconstruir: tudo que vive lá tem TTL curto.

## Escalar o worker

```bash
# quantas mensagens estão esperando, e há quanto tempo
docker exec financial-vellun-rabbitmq rabbitmqctl list_queues name messages consumers
```

No Railway, `numReplicas` em `infra/railway/ai-agent-worker.toml`. Antes de
subir réplica, confira que o downstream aguenta:

- **OpenAI:** `réplicas × PROCESSING_CONSUMER_CONCURRENCY` chamadas simultâneas;
- **API principal:** 3–5 requisições por mensagem, todas contra o pool do
  Postgres da API — é **ela** que precisa escalar junto, não o banco;
- **Meta:** `réplicas × OUTBOUND_CONSUMER_CONCURRENCY` entregas simultâneas.
