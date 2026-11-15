# EXPLAIN das consultas quentes — antes e depois dos índices

Registro exigido pelo critério de aceite do P2:
_"EXPLAIN antes e depois registrado para cada índice novo."_

Migration em questão: `apps/api/prisma/migrations/20260922210000_add_hot_path_indexes`.
Script: [`infra/database/explain-hot-queries.sql`](../infra/database/explain-hot-queries.sql).

## Como medir

```bash
# 1. ANTES — com o banco na migration anterior
pnpm db:up
psql "$DIRECT_URL" -v user_id="'<uuid-de-um-usuario-com-dados>'" \
  -f infra/database/explain-hot-queries.sql > /tmp/explain-antes.txt

# 2. Aplicar os índices
pnpm --filter @financial-vellun/api exec prisma migrate deploy

# 3. DEPOIS — mesmo usuário, mesmo script
psql "$DIRECT_URL" -v user_id="'<mesmo-uuid>'" \
  -f infra/database/explain-hot-queries.sql > /tmp/explain-depois.txt
```

E cole os planos nas tabelas abaixo.

**Uma base de desenvolvimento não serve para esta medição.** Com algumas
centenas de linhas o planner escolhe seq scan em tudo, e o "depois" fica igual
ao "antes" — o que não prova que o índice é inútil, prova que a tabela cabe em
poucas páginas. Meça contra volume real (réplica de produção, ou uma base
semeada pelo perfil de carga do P5).

## O que olhar em cada plano

| Sinal                              | Leitura                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `Seq Scan` numa tabela grande      | o índice não foi usado — ou não cobre o filtro                                     |
| `Index Scan` vs `Bitmap Heap Scan` | bitmap indica muitas linhas casando; normal em agregação                           |
| `Rows Removed by Filter` alto      | o índice traz linha demais; falta coluna na chave                                  |
| `Sort` antes de `Limit`            | a ordenação não veio do índice — é o que `[userId, transactionDate]` deve eliminar |
| `Buffers: shared read` alto        | leitura de disco; compare o número entre antes e depois                            |
| `actual time` do nó externo        | o número que conta                                                                 |

`Buffers` importa mais que o tempo: o tempo varia com o cache do momento, o
número de páginas lidas não.

## Resultados

> **Pendente de execução.** As medições abaixo precisam de um Postgres no ar com
> volume representativo; ainda não foram coletadas. Preencher antes de
> considerar o P2 fechado.

### 1. Listagem de lançamentos (`transactions.service.ts:findAll`)

Índice esperado: `transactions_user_id_transaction_date_idx`.
Hipótese: elimina o `Sort` — o índice já entrega na ordem do `ORDER BY`.

|        | Plano         | `actual time` | `shared read` |
| ------ | ------------- | ------------- | ------------- |
| Antes  | _a preencher_ |               |               |
| Depois | _a preencher_ |               |               |

### 2. Dashboard pessoal — soma por tipo no período

Índice esperado: `transactions_user_id_status_type_transaction_date_idx`.

|        | Plano         | `actual time` | `shared read` |
| ------ | ------------- | ------------- | ------------- |
| Antes  | _a preencher_ |               |               |
| Depois | _a preencher_ |               |               |

### 3. Dashboard pessoal — lançamentos recentes

Índice esperado: `transactions_user_id_created_at_idx`.
É o índice com a justificativa mais fraca das três (`LIMIT 5`); se o EXPLAIN não
mostrar ganho, **remova-o**: cada índice custa escrita em toda inserção, e o
caminho de inserção é o do pipeline do WhatsApp.

|        | Plano         | `actual time` | `shared read` |
| ------ | ------------- | ------------- | ------------- |
| Antes  | _a preencher_ |               |               |
| Depois | _a preencher_ |               |               |

### 4. Comparativo mensal (1 query, era 24)

|                    | Plano         | `actual time` | `shared read` |
| ------------------ | ------------- | ------------- | ------------- |
| Antes (uma das 24) | _a preencher_ |               |               |
| Depois (a única)   | _a preencher_ |               |               |

A comparação honesta aqui não é plano contra plano: é **24 round-trips contra
1**. Meça o tempo total de `GET /dashboard/summary` nos dois casos.

### 5. Contas a pagar/receber

Índice esperado: `transactions_user_id_status_type_transaction_date_idx`.

|        | Plano         | `actual time` | `shared read` |
| ------ | ------------- | ------------- | ------------- |
| Antes  | _a preencher_ |               |               |
| Depois | _a preencher_ |               |               |

### 6. Série diária do mês

|        | Plano         | `actual time` | `shared read` |
| ------ | ------------- | ------------- | ------------- |
| Antes  | _a preencher_ |               |               |
| Depois | _a preencher_ |               |               |

### 7. Conversa ativa do contato (`internal.service.ts`)

Índice esperado: `ai_conversations_whatsapp_contact_id_status_created_at_idx`.
A tabela não tinha índice nenhum além da PK, e esta consulta roda **em toda
mensagem recebida** — inclusive dentro do `SELECT ... FOR UPDATE`, onde um seq
scan segura o lock por mais tempo.

|        | Plano         | `actual time` | `shared read` |
| ------ | ------------- | ------------- | ------------- |
| Antes  | _a preencher_ |               |               |
| Depois | _a preencher_ |               |               |

## Índices removidos

A migration derruba `transactions_user_id_idx`,
`transactions_transaction_date_idx` e `transactions_type_idx`. Confirme, depois
de algum tráfego, que nenhum plano piorou e que os novos estão sendo usados:

```sql
SELECT relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
  FROM pg_stat_user_indexes WHERE relname = 'transactions' ORDER BY idx_scan;
```

`idx_scan = 0` num índice novo, depois de um dia de tráfego, quer dizer que ele
só custa escrita.
