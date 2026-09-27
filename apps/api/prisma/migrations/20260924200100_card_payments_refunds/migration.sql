-- Pagamentos de fatura e estornos (fase 4). Regras: docs/adrs/0015-pagamentos-e-estornos.md

-- CreateEnum
CREATE TYPE "TransferDirection" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "CardPaymentStatus" AS ENUM ('active', 'reversed');

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "card_payment_id" TEXT,
ADD COLUMN     "refund_of_id" TEXT,
ADD COLUMN     "transfer_direction" "TransferDirection";

-- CreateTable
CREATE TABLE "card_payments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credit_card_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "source_account_id" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "payment_date" DATE NOT NULL,
    "status" "CardPaymentStatus" NOT NULL DEFAULT 'active',
    "idempotency_key" TEXT NOT NULL,
    "reversed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "card_payments_idempotency_key_key" ON "card_payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "card_payments_invoice_id_idx" ON "card_payments"("invoice_id");

-- CreateIndex
CREATE INDEX "card_payments_user_id_idx" ON "card_payments"("user_id");

-- CreateIndex
CREATE INDEX "transactions_card_payment_id_idx" ON "transactions"("card_payment_id");

-- CreateIndex
CREATE INDEX "transactions_refund_of_id_idx" ON "transactions"("refund_of_id");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_card_payment_id_fkey" FOREIGN KEY ("card_payment_id") REFERENCES "card_payments"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_refund_of_id_fkey" FOREIGN KEY ("refund_of_id") REFERENCES "transactions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_credit_card_id_fkey" FOREIGN KEY ("credit_card_id") REFERENCES "credit_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "credit_card_invoices"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_source_account_id_fkey" FOREIGN KEY ("source_account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

