-- Conta ou cartão preferencial para lançamentos (substitui o "cartão principal").
-- Ninguém herda preferência: o principal antigo não vira preferencial (docs/adrs/0016).

-- AlterTable
ALTER TABLE "credit_cards" DROP COLUMN "is_primary";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "preferred_account_id" TEXT;

-- CreateIndex
CREATE INDEX "users_preferred_account_id_idx" ON "users"("preferred_account_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_preferred_account_id_fkey" FOREIGN KEY ("preferred_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

