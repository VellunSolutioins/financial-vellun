-- AlterTable
ALTER TABLE "ai_extracted_transactions" ADD COLUMN     "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ai_extracted_transactions_idempotency_key_key" ON "ai_extracted_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "ai_extracted_transactions_transaction_id_idx" ON "ai_extracted_transactions"("transaction_id");

-- CreateIndex
CREATE INDEX "ai_extracted_transactions_user_id_idx" ON "ai_extracted_transactions"("user_id");
