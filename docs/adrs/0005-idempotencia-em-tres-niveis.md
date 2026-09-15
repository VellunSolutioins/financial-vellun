# 0005 — Idempotência em três níveis

- **Status:** Aceito
- **Data:** 2026-09-05

## Contexto

Entrega "pelo menos uma vez" é a garantia de qualquer broker: a mesma mensagem
pode chegar duas vezes. A Meta também reenvia o webhook quando não recebe o ack
a tempo. E existe o caso mais traiçoeiro: o `POST /internal/transactions/from-ai`
**cria o lançamento** e a resposta se perde por timeout — para o consumer é uma
falha, ele tenta de novo, e o usuário acaba com dois lançamentos.

O `createTransactionFromAi` fazia um `prisma.transaction.create` puro, sem
nenhuma chave, e a criação do lançamento e o vínculo com a extração não estavam
na mesma transação de banco.

A extração de IA (`AiExtractedTransaction`) tinha o mesmo problema, com um efeito
pior do que uma linha duplicada: como a criação do lançamento é deduplicada
**antes** de gravar, o retry saía cedo e nunca vinculava a segunda extração —
que ficava `confirmed` com `transactionId` nulo, poluindo a trilha de auditoria
lida por `GET /transactions/:id/ai-audit`.

## Decisão

Idempotência em três pontos, cada um cobrindo o que o anterior não cobre.

**1. Entrada — `providerMessageId`.** `AiMessage.providerMessageId` já é único.
O `POST /internal/ai-events` faz leitura antes da escrita e trata `P2002`,
devolvendo `duplicate: true`. O consumer trata duplicata como **sucesso**: acka
sem reprocessar.

**2. Job consolidado — `jobId` determinístico.**
`jobId = uuid5(namespace, phone + "|" + sorted(sourceMessageIds))`. O mesmo
conjunto de mensagens sempre produz o mesmo job, então a republicação de um
grupo (crash entre o confirm e a limpeza do buffer) não vira um segundo job. O
consumer marca `job:done:{jobId}` no Redis após concluir e descarta reentregas.

**3. Efeitos do job no banco — `idempotencyKey` (= `jobId`).** As duas escritas
persistentes de um job ganham a mesma proteção, com colunas anuláveis e índice
único:

| Tabela                      | Coluna            | Endpoint                              |
| --------------------------- | ----------------- | ------------------------------------- |
| `transactions`              | `idempotency_key` | `POST /internal/transactions/from-ai` |
| `ai_extracted_transactions` | `idempotency_key` | `POST /internal/ai-events`            |

Nos dois casos o serviço lê antes de escrever, trata `P2002` (corrida entre
workers) e devolve o registro existente marcado (`idempotent: true` no
lançamento, `duplicate: true` na extração). A criação do lançamento e o `update`
da extração passam a rodar dentro de `prisma.$transaction`.

Deduplicar a extração é o que mantém a auditoria coerente no retry: o agente
recebe de volta **o mesmo** `extractionId` e continua vinculando o lançamento a
ele, em vez de deixar uma segunda extração órfã.

Os três níveis são necessários: o marcador Redis do nível 2 é gravado **depois**
do efeito, então um timeout entre gravar no banco e marcar o job só é coberto
pelo nível 3.

### Por que não `unique` em `sourceMessageId`

Seria o reflexo óbvio do problema ("a mesma mensagem gerou duas extrações"), mas
falha justamente onde mais importa:

- `sourceMessageId` é **anulável**, e o Postgres permite vários `NULL` num
  índice único. Quando a API principal está instável, a inbound é persistida sem
  id e o campo fica nulo — exatamente o cenário em que os retries acontecem, e
  em que a constraint não protegeria nada;
- amarra a constraint a uma propriedade incidental do fluxo atual (hoje, uma
  extração por mensagem). Uma mensagem que um dia gere dois lançamentos
  ("gastei 50 no mercado e 30 na farmácia") passaria a violar a constraint com
  dados legítimos.

A chave derivada do job não tem nenhum dos dois problemas e é o mesmo padrão já
usado no lançamento.

## Consequências

**Ganhos**

- Reenvio do webhook não duplica `AiMessage`.
- Republicação de grupo não gera dois jobs.
- Retry após timeout devolve o lançamento existente em vez de criar outro.
- Retry não deixa extração órfã: o mesmo `extractionId` volta e continua
  vinculado ao lançamento.
- Lançamento e rastreabilidade da extração passam a ser atômicos.

**Custos**

- Uma leitura a mais por criação de lançamento e por registro de extração
  (mitigadas pelos índices únicos).
- Uma coluna e um índice novos em `transactions` e em
  `ai_extracted_transactions`. As migrations são aditivas e compatíveis com os
  dados existentes (colunas anuláveis).
- No modo `MESSAGE_PIPELINE=legacy` não há `jobId`, então a chave vai nula e não
  há deduplicação — o comportamento é o mesmo de antes.
- `job:done:{jobId}` tem TTL (`JOB_DEDUPE_TTL_SECONDS`, 24 h): uma reentrega
  depois disso passaria pelo nível 2 — e é o nível 3 que segura.

## Alternativas consideradas

- **Confiar só na deduplicação do webhook.** Rejeitada: não cobre o timeout
  depois da criação, que é exatamente o caso que duplica lançamento.
- **Chave de idempotência aleatória por tentativa.** Não serve: precisa ser
  derivada do conteúdo para que o retry apresente a mesma chave.
- **Tabela separada de chaves de idempotência.** Mais genérica, mas exige uma
  segunda escrita e sincronização com a transação; a coluna única resolve o caso
  concreto com menos peças.
- **`unique` em `sourceMessageId`** para a extração — ver a análise acima.
