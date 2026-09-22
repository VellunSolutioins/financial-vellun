-- Índices das consultas quentes (P2 do plano de performance).
--
-- `CONCURRENTLY` não é usado aqui de propósito: o Prisma roda cada migration
-- dentro de uma transação, e `CREATE INDEX CONCURRENTLY` não pode rodar em
-- transação. Nas tabelas deste projeto, no volume atual, o lock de `CREATE
-- INDEX` dura frações de segundo. Se um dia `transactions` crescer a ponto de
-- isso doer, o caminho é criar o índice à mão, fora da migration, e marcá-la
-- como aplicada (`prisma migrate resolve --applied`).

-- Listagem de lançamentos e série diária do dashboard: sempre `user_id` fixo,
-- ordenado ou filtrado por data.
CREATE INDEX "transactions_user_id_transaction_date_idx"
  ON "transactions" ("user_id", "transaction_date");

-- Agregações do dashboard (soma por tipo no período) e as listas de contas a
-- pagar/receber (`status = 'pending'`). `status` antes de `type` porque as
-- consultas deste grupo fixam os dois, e a data vem por último por ser a única
-- usada como faixa.
CREATE INDEX "transactions_user_id_status_type_transaction_date_idx"
  ON "transactions" ("user_id", "status", "type", "transaction_date");

-- "Lançamentos recentes": ordena por `created_at`, não por `transaction_date` —
-- um lançamento de ontem registrado agora precisa aparecer no topo.
CREATE INDEX "transactions_user_id_created_at_idx"
  ON "transactions" ("user_id", "created_at");

-- Redundantes depois dos compostos acima: toda consulta a lançamento é escopada
-- por usuário, então um índice que começa por `transaction_date` ou por `type`
-- nunca é o melhor caminho — e cada índice extra custa escrita em toda inserção
-- (é este caminho que o pipeline do WhatsApp percorre a cada mensagem).
--
-- `transactions_user_id_idx` sai porque `(user_id, transaction_date)` o prefixa:
-- o planner usa o composto para tudo que o de coluna única atendia.
DROP INDEX IF EXISTS "transactions_user_id_idx";
DROP INDEX IF EXISTS "transactions_transaction_date_idx";
DROP INDEX IF EXISTS "transactions_type_idx";

-- Conversa ativa de um contato: lida em toda mensagem recebida, inclusive
-- dentro do `SELECT ... FOR UPDATE` que serializa a criação. A tabela não tinha
-- índice nenhum além da PK.
CREATE INDEX "ai_conversations_whatsapp_contact_id_status_created_at_idx"
  ON "ai_conversations" ("whatsapp_contact_id", "status", "created_at");
