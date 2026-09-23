-- Remove o status "pending" dos lançamentos.
--
-- O que ainda vai acontecer passa a ser definido pela data (futuro = depois de
-- hoje), não por status. O saldo das contas já só considera lançamentos até
-- hoje, então converter os pendentes em confirmados não antecipa parcelas
-- futuras no saldo. Um pendente com data passada (conta não marcada como paga)
-- passa a contar como realizado.
UPDATE "transactions" SET "status" = 'confirmed' WHERE "status" = 'pending';

-- Postgres não remove valor de enum: recria o tipo e converte a coluna.
ALTER TYPE "TransactionStatus" RENAME TO "TransactionStatus_old";
CREATE TYPE "TransactionStatus" AS ENUM ('confirmed', 'cancelled');

ALTER TABLE "transactions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "transactions"
  ALTER COLUMN "status" TYPE "TransactionStatus" USING ("status"::text::"TransactionStatus");
ALTER TABLE "transactions" ALTER COLUMN "status" SET DEFAULT 'confirmed';

DROP TYPE "TransactionStatus_old";

-- Recompõe o saldo com a regra nova (mesma de AccountsService.recalculateBalance):
-- saldo inicial + confirmados com data até hoje em America/Sao_Paulo.
UPDATE "accounts" a
   SET "current_balance" = a."initial_balance" + COALESCE((
         SELECT SUM(CASE WHEN t."type" = 'income' THEN t."amount"
                         WHEN t."type" = 'expense' THEN -t."amount"
                         ELSE 0 END)
           FROM "transactions" t
          WHERE t."account_id" = a."id"
            AND t."status" = 'confirmed'
            AND t."transaction_date" <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
       ), 0);
