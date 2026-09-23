-- Frequência dos lançamentos fixos. Até aqui todo fixo era mensal.
CREATE TYPE "RecurrenceFrequency" AS ENUM ('monthly', 'bimonthly', 'semiannual', 'annual');

ALTER TABLE "transactions" ADD COLUMN "recurrence_frequency" "RecurrenceFrequency";

UPDATE "transactions" SET "recurrence_frequency" = 'monthly' WHERE "recurrence_type" = 'fixo';
