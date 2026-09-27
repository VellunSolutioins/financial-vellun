-- Faturas de cartão (fase 3). Ciclo, atribuição e regras: docs/adrs/0014-faturas-ciclos-e-limite.md
-- Nenhuma fatura é criada aqui: o CardLedgerService as cria quando um lançamento
-- cai no ciclo, e `pnpm --filter @financial-vellun/api db:backfill:invoices` atribui
-- os lançamentos de cartões já configurados.

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "invoice_id" TEXT;

-- CreateTable
CREATE TABLE "credit_card_invoices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credit_card_id" TEXT NOT NULL,
    "reference_month" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "closing_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_card_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_card_invoices_user_id_idx" ON "credit_card_invoices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_card_invoices_credit_card_id_reference_month_key" ON "credit_card_invoices"("credit_card_id", "reference_month");

-- CreateIndex
CREATE INDEX "transactions_invoice_id_idx" ON "transactions"("invoice_id");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "credit_card_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_invoices" ADD CONSTRAINT "credit_card_invoices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_invoices" ADD CONSTRAINT "credit_card_invoices_credit_card_id_fkey" FOREIGN KEY ("credit_card_id") REFERENCES "credit_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

