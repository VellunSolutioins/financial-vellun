-- CreateEnum
CREATE TYPE "RecurrenceType" AS ENUM ('avulso', 'fixo', 'parcelado');

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "installment_number" INTEGER,
ADD COLUMN     "installment_total" INTEGER,
ADD COLUMN     "recurrence_type" "RecurrenceType" NOT NULL DEFAULT 'avulso',
ADD COLUMN     "series_id" TEXT;

-- CreateIndex
CREATE INDEX "transactions_series_id_idx" ON "transactions"("series_id");
