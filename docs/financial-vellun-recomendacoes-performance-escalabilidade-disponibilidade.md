# Recomendações de Performance, Escalabilidade e Disponibilidade --- Financial Vellun

## 1. Objetivo

Este documento consolida recomendações técnicas para evolução do projeto
**financial-vellun**, com foco em:

- performance;
- escalabilidade horizontal;
- disponibilidade;
- isolamento de falhas;
- eficiência no uso de PostgreSQL, Redis e RabbitMQ;
- capacidade operacional e observabilidade.

A análise considera a arquitetura atual do projeto, incluindo API
NestJS, AI Agent em Python/FastAPI, RabbitMQ, Redis, PostgreSQL,
integração com WhatsApp e OpenAI, mecanismos de retry/DLQ, idempotência,
locks distribuídos e a infraestrutura de observabilidade.

---

## 2. Diagnóstico geral

A arquitetura atual já possui fundamentos importantes para crescimento:

- RabbitMQ com filas duráveis;
- mensagens persistentes;
- publisher confirms;
- ACK manual;
- prefetch configurável;
- retry e DLQ;
- idempotência;
- Redis para estado distribuído;
- locks distribuídos por telefone;
- graceful shutdown;
- métricas e logs estruturados;
- Grafana Cloud, Loki e Alloy;
- métricas de RabbitMQ, Redis, PostgreSQL e aplicação.

Portanto, a prioridade não deve ser substituir tecnologias ou migrar
prematuramente para uma arquitetura de microservices.

Os principais ganhos estão em **desacoplar workloads, otimizar acesso ao
PostgreSQL, controlar concorrência e melhorar a elasticidade
operacional**.

---

## 3. Prioridades

---

Prioridade Recomendação Objetivo

---

P0 Separar webhook/API do Escala independente e
AI Agent dos consumers isolamento de falhas

P0 Revisar índices Reduzir custo das
compostos no PostgreSQL consultas principais

P1 Criar pipeline outbound Isolar WhatsApp do
assíncrono processamento principal

P1 Escalar workers baseado Elasticidade orientada
em backlog à demanda

P1 Definir connection Proteger PostgreSQL
budget e pooling

P1 Melhorar readiness e Disponibilidade e
health checks deploy seguro

P2 Adicionar cache Reduzir consultas
seletivo repetitivas

P2 Avaliar polling do Eficiência
GroupFlusher em alta  
 escala

P2 Declarar infraestrutura Recuperabilidade e
e deploy previsibilidade

---

---

## 4. Separar AI Agent HTTP dos workers

O projeto já suporta conceitualmente essa separação através de
`RUN_CONSUMERS_IN_API` e do entrypoint `worker.py`.

A topologia de produção recomendada é:

```text
                    ┌── AI Agent HTTP #1
WhatsApp ── LB ─────┤
                    └── AI Agent HTTP #2
                             │
                             ▼
                         RabbitMQ
                             │
                ┌────────────┼────────────┐
                ▼            ▼            ▼
             Worker 1     Worker 2     Worker N
```

### Benefícios

O recebimento de webhooks e o processamento de mensagens possuem
características diferentes.

O webhook deve:

- responder rapidamente;
- realizar pouco processamento;
- publicar a mensagem;
- permanecer disponível mesmo quando serviços downstream estiverem
  lentos.

Os workers executam operações potencialmente lentas:

- chamadas à OpenAI;
- consultas ao Redis;
- chamadas à API NestJS;
- operações no PostgreSQL;
- processamento conversacional;
- integrações externas.

Separando os processos, torna-se possível escalar cada camada
independentemente.

### Configuração esperada

Serviço HTTP:

```text
RUN_CONSUMERS_IN_API=false
```

Worker:

```text
python -m src.worker
```

Essa mudança deve ser uma das primeiras evoluções de infraestrutura.

---

## 5. Revisar índices de `Transaction`

Atualmente existem índices individuais como:

```prisma
@@index([userId])
@@index([transactionDate])
@@index([type])
@@index([categoryId])
@@index([accountId])
```

Entretanto, consultas reais combinam frequentemente:

```text
userId
type
status
transactionDate
```

Exemplo conceitual:

```sql
WHERE user_id = ?
  AND type = ?
  AND status = 'confirmed'
  AND transaction_date BETWEEN ? AND ?
```

Também existem listagens semelhantes a:

```sql
WHERE user_id = ?
ORDER BY transaction_date DESC
```

Índices individuais podem não ser suficientes conforme a tabela cresce.

### Candidatos a avaliação

```prisma
@@index([userId, transactionDate])
@@index([userId, status, transactionDate])
@@index([userId, type, status, transactionDate])
```

Não é recomendado adicionar todos indiscriminadamente.

Cada índice:

- ocupa armazenamento;
- aumenta custo de INSERT;
- aumenta custo de UPDATE;
- aumenta manutenção interna do PostgreSQL.

A decisão deve ser baseada em consultas reais utilizando:

```sql
EXPLAIN (ANALYZE, BUFFERS)
```

O índice `[userId, transactionDate]` é um candidato especialmente
relevante devido à natureza multiusuário da aplicação.

---

## 6. Índice para conversações do WhatsApp

Existe consulta equivalente a:

```typescript
aiConversation.findFirst({
  where: {
    whatsappContactId: contact.id,
    status: 'active',
  },
  orderBy: {
    createdAt: 'desc',
  },
});
```

Um índice composto adequado deve ser avaliado:

```prisma
@@index([whatsappContactId, status, createdAt])
```

Esse índice reduz o custo de localizar a conversa ativa mais recente de
um contato conforme o histórico cresce.

---

## 7. Criar fila outbound para WhatsApp

Atualmente, o envio da resposta ao WhatsApp faz parte do fluxo de
processamento.

Conceitualmente:

```text
consume job
    ↓
contexto
    ↓
OpenAI
    ↓
criação do lançamento
    ↓
WhatsApp API
    ↓
ACK
```

Isso faz com que a disponibilidade e latência da Meta façam parte da
critical path do worker.

A arquitetura recomendada é:

```text
processing queue
      │
      ▼
 AI Worker
      │
      ├── persistência / transação
      │
      └── publish
             │
             ▼
      whatsapp.outbound.v1
             │
             ▼
       Outbound Worker
             │
             ▼
      WhatsApp Cloud API
```

### Topologia sugerida

```text
whatsapp.outbound.v1
whatsapp.outbound.retry.*
whatsapp.outbound.dlq
```

### Benefícios

Se ocorrer:

```text
OpenAI      → disponível
PostgreSQL  → disponível
RabbitMQ    → disponível
WhatsApp    → indisponível
```

o processamento principal continua funcionando.

A indisponibilidade do WhatsApp passa a gerar backlog apenas na fila
outbound.

Isso melhora:

- isolamento de falhas;
- throughput;
- retry;
- capacidade operacional;
- observabilidade.

---

## 8. Escalabilidade baseada em backlog

O projeto possui controles como:

```text
RABBITMQ_PREFETCH
INBOUND_CONSUMER_CONCURRENCY
PROCESSING_CONSUMER_CONCURRENCY
```

Esses parâmetros são adequados para controlar concorrência local.

Para escalabilidade horizontal, porém, CPU não deve ser o único
indicador.

Um indicador melhor é:

```text
queue_depth / processing_rate = estimated_drain_time
```

Exemplo:

```text
300 jobs aguardando
30 jobs/min processados

estimated_drain_time ≈ 10 minutos
```

Outro indicador especialmente importante é:

```text
oldest_message_age_seconds
```

`queue_depth = 100` isoladamente fornece pouca informação.

Já:

```text
oldest_message_age_seconds = 270
```

indica que existe uma mensagem aguardando 4 minutos e 30 segundos.

Esse indicador representa melhor a experiência real do usuário.

---

## 9. Controle explícito de concorrência

Escalabilidade horizontal aumenta a concorrência contra serviços
downstream.

Exemplo:

```text
10 workers
×
10 jobs simultâneos
=
100 processamentos concorrentes
```

Cada processamento pode utilizar:

- NestJS;
- PostgreSQL;
- Redis;
- OpenAI;
- WhatsApp.

Portanto:

```text
workers × processing_concurrency
```

deve respeitar a capacidade dos serviços downstream.

Uma regra operacional importante é:

```text
workers × processing_concurrency <= downstream_capacity
```

Devem ser considerados principalmente:

- limite de conexões PostgreSQL;
- rate limits da OpenAI;
- rate limits da Meta;
- capacidade da API NestJS;
- capacidade do Redis;
- tamanho do pool HTTP.

Escalar workers sem controlar essas dependências pode simplesmente
deslocar o gargalo.

---

## 10. PostgreSQL como provável gargalo estrutural

RabbitMQ e Redis possuem capacidade suficiente para volumes muito
superiores aos esperados nas fases iniciais do produto.

O PostgreSQL tende a se tornar um gargalo antes deles porque várias
partes do sistema convergem para o banco.

```text
Frontend
   │
NestJS
   │
PostgreSQL
   ▲
   │
AI Agent / Workers
```

Quando ocorre escalabilidade horizontal:

```text
API × N
Workers × N
```

o número potencial de conexões também cresce.

### Recomendação

Adotar pooling controlado:

```text
PostgreSQL
     │
 PgBouncer
     │
 ┌───┴──────────────┐
API replicas     Workers
```

ou utilizar solução equivalente fornecida pelo provedor.

### Connection budget

Deve existir um orçamento explícito de conexões.

Exemplo conceitual:

```text
PostgreSQL max_connections = 100

infra/admin = 15
API         = 35
workers     = 40
outros      = 10
```

O número real deve ser definido conforme infraestrutura e carga.

Sem esse controle, autoscaling pode causar connection exhaustion no
banco.

---

## 11. Cache seletivo

Redis já faz parte da arquitetura, mas não é recomendado utilizar cache
indiscriminadamente.

Dados financeiros possuem requisitos fortes de consistência.

Bons candidatos a cache são dados relativamente estáveis:

- categorias;
- contas ativas;
- plano;
- assinatura;
- configurações;
- metadados utilizados frequentemente pelo AI Agent.

Exemplo:

```text
categories:{userId}
TTL = 5 minutos
```

Isso pode transformar determinados caminhos de:

```text
Worker → NestJS → PostgreSQL
```

em:

```text
Worker → Redis
```

O cache deve ser introduzido somente após medição das queries e
definição clara da estratégia de invalidação.

---

## 12. Redis como infraestrutura crítica

Redis atualmente participa de:

```text
agrupamento
locks
conversation state
job deduplication
```

Portanto, ele deixou de ser apenas uma camada de cache.

Uma indisponibilidade do Redis pode afetar diretamente o pipeline do
WhatsApp.

Redis deve ser tratado operacionalmente como infraestrutura de estado.

Devem ser avaliados:

- persistência;
- backups quando aplicável;
- política de eviction;
- limite de memória;
- disponibilidade;
- monitoramento;
- estratégia de recuperação.

Não há necessidade arquitetural evidente de remover Redis. A tecnologia
é adequada ao problema.

---

## 13. Lock por telefone

O projeto utiliza lock distribuído:

```text
proc:lock:{phone}
```

Essa decisão preserva ordenação e consistência da conversa.

Sem o lock:

```text
mensagem A ──┐
             ├── processamento simultâneo
mensagem B ──┘
```

poderia gerar alterações inconsistentes no estado conversacional.

O efeito deliberado é:

```text
throughput por telefone = 1
```

O sistema escala entre usuários, e não dentro da mesma conversa.

Para o domínio do Financial, esse trade-off é adequado: consistência
conversacional é mais importante do que paralelismo dentro de uma única
conversa.

---

## 14. RabbitMQ

Não existe indicação atual de que RabbitMQ seja um gargalo arquitetural.

A implementação já possui características importantes:

```text
durable queues
persistent messages
publisher confirms
manual ACK
prefetch
retry
DLQ
idempotência
graceful shutdown
```

Não é recomendada uma migração prematura para Kafka, SQS ou outra
tecnologia apenas por preocupação genérica com escalabilidade.

RabbitMQ é adequado ao workload atual.

O foco deve permanecer em:

- tuning de prefetch;
- concorrência;
- número de consumers;
- queue age;
- backlog;
- tempo de processamento.

---

## 15. Observabilidade e SLOs

A infraestrutura atual já possui uma base relevante:

```text
Prometheus
Grafana Cloud
Loki
Alloy
RabbitMQ metrics
Redis metrics
PostgreSQL metrics
Application metrics
```

Isso permite uma abordagem orientada por medição.

### Métricas recomendadas

Adicionar ou priorizar:

```text
webhook_to_ack_latency
message_end_to_end_latency
queue_oldest_message_age
transaction_creation_latency
```

Acompanhar distribuições:

```text
p50
p95
p99
```

### Principal SLI do pipeline

Um indicador importante deve representar o fluxo completo:

```text
WhatsApp message
      ↓
webhook
      ↓
RabbitMQ
      ↓
grouping
      ↓
processing
      ↓
OpenAI
      ↓
transaction
      ↓
reply
```

A métrica deve responder:

> Quanto tempo leva entre a mensagem enviada pelo usuário e a conclusão
> do processamento/resposta?

Esse indicador representa melhor a experiência real do usuário do que
CPU ou memória isoladamente.

---

## 16. Readiness e health checks

Health checks devem distinguir:

```text
liveness
readiness
```

### Liveness

Responde:

> O processo está funcionando?

Não deve depender de todos os serviços externos.

### Readiness

Responde:

> Esta instância está apta a receber trabalho?

Para workers, pode considerar dependências essenciais como:

- RabbitMQ;
- Redis;
- API interna quando necessária.

Para o webhook, a dependência crítica principal é a capacidade de
publicar de forma durável no broker.

Essa separação melhora rolling deployments e evita direcionar tráfego
para instâncias incapazes de processá-lo corretamente.

---

## 17. GroupFlusher e polling

O agrupamento distribuído utiliza Redis e polling periódico.

Esse modelo é simples e adequado ao volume atual.

Em volumes muito superiores, polling constante pode gerar trabalho
desnecessário.

Não é prioridade alterar essa arquitetura agora.

A recomendação é medir:

```text
poll executions
groups found per poll
groups flushed per second
Redis commands/sec
```

Se a maioria dos polls retornar vazia em uma infraestrutura muito maior,
pode valer avaliar uma estratégia orientada a eventos ou timers
distribuídos.

Até existir evidência de gargalo, manter a implementação atual é
preferível.

---

## 18. Infraestrutura e deploy declarativos

Parte da configuração de produção ainda depende do painel do Railway.

Isso gera risco operacional porque infraestrutura importante pode
existir apenas como estado externo ao repositório.

No médio prazo, devem ser versionados:

- configuração de deploy;
- comandos de inicialização;
- variáveis documentadas;
- health checks;
- número mínimo de réplicas;
- políticas de restart;
- configuração de observabilidade;
- infraestrutura possível via IaC.

O objetivo é permitir:

```text
repositório + secrets
        ↓
reconstrução previsível do ambiente
```

Isso melhora disaster recovery e reduz configuration drift.

---

## 19. Arquitetura-alvo recomendada

A evolução não exige decomposição prematura em microservices.

Uma arquitetura adequada seria:

```text
                         ┌───────────────┐
                         │   Frontend    │
                         └───────┬───────┘
                                 │
                                 ▼
                         ┌───────────────┐
                         │  NestJS API   │ × N
                         └───────┬───────┘
                                 │
                              PgBouncer
                                 │
                                 ▼
                            PostgreSQL


WhatsApp
    │
    ▼
┌──────────────────┐
│ Webhook / Agent  │ × N
└────────┬─────────┘
         │
         ▼
     RabbitMQ
         │
   ┌─────┴─────────┐
   ▼               ▼
Inbound         Processing
Workers          Workers
                    │
             ┌──────┼───────┐
             ▼      ▼       ▼
           Redis  OpenAI   NestJS
                    │
                    ▼
             outbound queue
                    │
                    ▼
             Outbound Workers
                    │
                    ▼
                 WhatsApp
```

A aplicação continua essencialmente composta por:

```text
1 monorepo
1 API principal
1 agente
1 PostgreSQL
1 Redis
1 RabbitMQ
```

A diferença é que os processos passam a possuir responsabilidades
operacionais mais bem definidas.

---

## 20. Sequência recomendada de evolução

### Fase 1 --- isolamento de workloads

1.  Separar `ai-agent` HTTP e `ai-agent-worker` no Railway.
2.  Configurar `RUN_CONSUMERS_IN_API=false` no serviço HTTP.
3.  Criar serviço dedicado executando `python -m src.worker`.
4.  Validar graceful shutdown e comportamento durante deploy.

### Fase 2 --- PostgreSQL

1.  Identificar queries mais frequentes/lentas.
2.  Executar `EXPLAIN (ANALYZE, BUFFERS)`.
3.  Avaliar índices compostos.
4.  Definir connection budget.
5.  Avaliar PgBouncer ou pooling equivalente.

### Fase 3 --- outbound assíncrono

1.  Criar `whatsapp.outbound.v1`.
2.  Criar retries.
3.  Criar DLQ.
4.  Criar outbound worker.
5.  Remover chamada direta ao WhatsApp da critical path do processing
    worker.

### Fase 4 --- métricas de capacidade

Adicionar:

```text
queue_depth
queue_oldest_message_age
processing_rate
message_end_to_end_latency
processing_latency
OpenAI latency
API latency
PostgreSQL connection utilization
```

### Fase 5 --- teste de carga

Executar cenários como:

```text
10 mensagens/min
100 mensagens/min
500 mensagens/min
1000 mensagens/min
```

Medir:

- p50;
- p95;
- p99;
- backlog;
- drain time;
- CPU;
- memória;
- conexões PostgreSQL;
- conexões Redis;
- taxa de consumo RabbitMQ;
- latência OpenAI.

### Fase 6 --- tuning

Somente após essas medições ajustar:

```text
RABBITMQ_PREFETCH
INBOUND_CONSUMER_CONCURRENCY
PROCESSING_CONSUMER_CONCURRENCY
número de workers
HTTP connection pools
PostgreSQL connection pools
```

---

## 21. Capacity review recomendado

Antes de aumentar agressivamente a concorrência, deve ser realizado um
capacity review do pipeline.

Para cada mensagem:

```text
WhatsApp
   ↓
Webhook
   ↓
RabbitMQ
   ↓
Grouping
   ↓
Processing Worker
   ↓
Redis
   ↓
NestJS
   ↓
PostgreSQL
   ↓
OpenAI
   ↓
Outbound
```

devem ser levantados:

- número de operações Redis;
- número de queries SQL;
- número de chamadas HTTP internas;
- número de chamadas OpenAI;
- tempo médio por etapa;
- p95/p99 por etapa;
- número de conexões utilizadas;
- consumo médio de CPU;
- consumo médio de memória.

Com esses dados é possível estimar:

```text
throughput por worker
workers necessários
capacidade máxima antes de saturar PostgreSQL
capacidade máxima antes de atingir rate limits externos
tempo necessário para drenar backlog
```

Essa análise deve orientar o dimensionamento, em vez de aumentar
concorrência com base apenas em intuição.

---

## 22. Conclusão

O `financial-vellun` já possui fundamentos adequados para crescer sem
uma reescrita arquitetural.

As prioridades não são substituir RabbitMQ, Redis, PostgreSQL ou migrar
para microservices.

Os maiores ganhos esperados estão em:

1.  **separar HTTP e workers;**
2.  **otimizar índices e conexões PostgreSQL;**
3.  **desacoplar outbound do WhatsApp;**
4.  **controlar concorrência explicitamente;**
5.  **escalar workers usando backlog e queue age;**
6.  **definir SLOs e medir latência end-to-end;**
7.  **executar testes de carga antes de tuning agressivo.**

A arquitetura atual pode evoluir horizontalmente mantendo baixo nível de
complexidade operacional, desde que esses limites sejam tratados de
forma explícita.
