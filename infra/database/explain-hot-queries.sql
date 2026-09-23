-- EXPLAIN (ANALYZE, BUFFERS) das consultas quentes — P2 do plano de performance.
--
-- Rode **antes** da migration `20260922210000_add_hot_path_indexes` e **depois**
-- dela, com o mesmo `:user_id`, e guarde os dois resultados em
-- `docs/explain-consultas-quentes.md`. Sem o "antes", o "depois" não prova nada:
-- um plano com índice pode ser pior que um seq scan numa tabela pequena, e é
-- exatamente isso que se quer descobrir antes de carregar índice em produção.
--
--   psql "$DATABASE_URL" -v user_id="'<uuid>'" -f infra/database/explain-hot-queries.sql
--
-- O `ANALYZE` **executa** a consulta. Todas aqui são leitura, então é seguro.
--
-- Numa base de desenvolvimento com poucas centenas de linhas o planner vai
-- preferir seq scan em quase tudo, e o resultado não diz nada sobre produção.
-- Para medir de verdade: rode contra uma réplica com volume real, ou gere carga
-- antes (ver o seed de carga em `apps/ai-agent/scripts/loadtest.py`).

\timing on
\set ON_ERROR_STOP on

-- Estatísticas atualizadas: sem isso o planner decide com o que sobrou do
-- último autovacuum, e o plano medido não é o plano que roda amanhã.
ANALYZE "transactions";
ANALYZE "ai_conversations";

\echo '=== 1. Listagem de lançamentos (transactions.service.ts:findAll) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT t.*, c.*, a.*
  FROM "transactions" t
  LEFT JOIN "categories" c ON c."id" = t."category_id"
  LEFT JOIN "accounts"   a ON a."id" = t."account_id"
 WHERE t."user_id" = :user_id
 ORDER BY t."transaction_date" DESC
 LIMIT 10 OFFSET 0;

\echo '=== 1b. Contagem que acompanha a listagem ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM "transactions" WHERE "user_id" = :user_id;

\echo '=== 2. Dashboard pessoal: soma por tipo no período ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT sum("amount")
  FROM "transactions"
 WHERE "user_id" = :user_id
   AND "type" = 'expense'
   AND "status" = 'confirmed'
   AND "transaction_date" BETWEEN date_trunc('month', now())::date
                              AND (date_trunc('month', now()) + interval '1 month - 1 day')::date;

\echo '=== 3. Dashboard pessoal: lançamentos recentes ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM "transactions"
 WHERE "user_id" = :user_id
 ORDER BY "created_at" DESC
 LIMIT 5;

\echo '=== 4. Comparativo mensal, agora em UMA query (dashboard.service.ts) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT date_trunc('month', "transaction_date")::date AS month,
       "type",
       sum("amount") AS total
  FROM "transactions"
 WHERE "user_id" = :user_id
   AND "status" = 'confirmed'
   AND "type" IN ('income', 'expense')
   AND "transaction_date" >= (date_trunc('month', now()) - interval '11 months')::date
 GROUP BY 1, 2;

\echo '=== 5. Dashboard empresarial: contas a pagar/receber (status pending) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM "transactions"
 WHERE "user_id" = :user_id AND "type" = 'expense' AND "status" = 'pending'
 ORDER BY "transaction_date" ASC
 LIMIT 10;

\echo '=== 6. Série diária do mês (getDailyBreakdown) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "type", "amount", "transaction_date"
  FROM "transactions"
 WHERE "user_id" = :user_id
   AND "status" = 'confirmed'
   AND "type" IN ('income', 'expense')
   AND "transaction_date" BETWEEN date_trunc('month', now())::date
                              AND (date_trunc('month', now()) + interval '1 month - 1 day')::date;

\echo '=== 7. Conversa ativa do contato (internal.service.ts) ==='
-- Sem `:user_id`: pega qualquer contato existente, só para exercitar o plano.
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM "ai_conversations"
 WHERE "whatsapp_contact_id" = (SELECT "id" FROM "whatsapp_contacts" LIMIT 1)
   AND "status" = 'active'
 ORDER BY "created_at" DESC
 LIMIT 1;

\echo '=== Índices em uso (rode depois de algum tempo de tráfego) ==='
-- `idx_scan = 0` num índice antigo é o sinal de que ele só custa escrita.
SELECT relname AS tabela, indexrelname AS indice, idx_scan AS usos,
       pg_size_pretty(pg_relation_size(indexrelid)) AS tamanho
  FROM pg_stat_user_indexes
 WHERE relname IN ('transactions', 'ai_conversations')
 ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;
