-- Adiantamento de parcelas: a parcela adiantada vai para a data do adiantamento
-- e, no cartão, para a fatura aberta nessa data (docs/adrs/0017).

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "advanced_at" DATE,
ADD COLUMN     "advanced_from_date" DATE,
ADD COLUMN     "amount_before_advance" DECIMAL(15,2);
