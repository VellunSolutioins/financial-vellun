-- Separação Contas/Cartões (fase 1). Nenhum lançamento é tocado.
-- Decisões e regra dos dados legados: docs/adrs/0012-cartao-como-recurso-proprio.md

-- AlterTable
ALTER TABLE "credit_cards" ADD COLUMN     "closing_day" INTEGER,
ADD COLUMN     "invoice_tracking_start" DATE,
ADD COLUMN     "payment_account_id" TEXT,
ALTER COLUMN "due_day" DROP NOT NULL;

-- Dias do ciclo: 1–31 (o clamp para meses curtos é feito no cálculo do ciclo).
ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_closing_day_check" CHECK ("closing_day" BETWEEN 1 AND 31);
ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_due_day_check" CHECK ("due_day" BETWEEN 1 AND 31);

-- CreateIndex
CREATE INDEX "credit_cards_payment_account_id_idx" ON "credit_cards"("payment_account_id");

-- AddForeignKey
ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_payment_account_id_fkey" FOREIGN KEY ("payment_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- backfill:begin
-- O trecho entre os marcadores é idempotente e é reexecutado pelo teste de
-- integração (card-accounts.integration.spec.ts) sobre dados legados.

-- Pessoa jurídica não tem Cartões: uma conta `credit_card` órfã criada pela
-- tela de Contas vira `other` e continua visível e utilizável em Contas.
UPDATE "accounts" AS a
SET "type" = 'other', "updated_at" = CURRENT_TIMESTAMP
FROM "users" AS u
WHERE a."user_id" = u."id"
  AND u."profile_type" = 'business'
  AND a."type" = 'credit_card'
  AND NOT EXISTS (SELECT 1 FROM "credit_cards" c WHERE c."account_id" = a."id");

-- Pessoa física: toda conta `credit_card` sem cartão ganha um, com o mesmo
-- `account_id` e sem datas (configuração pendente).
INSERT INTO "credit_cards" ("id", "account_id", "is_primary", "created_at", "updated_at")
SELECT gen_random_uuid()::text, a."id", false, a."created_at", CURRENT_TIMESTAMP
FROM "accounts" AS a
WHERE a."type" = 'credit_card'
  AND NOT EXISTS (SELECT 1 FROM "credit_cards" c WHERE c."account_id" = a."id");

-- Quem não tinha cartão principal ativo passa a ter o mais antigo.
UPDATE "credit_cards" AS c
SET "is_primary" = true
FROM (
  SELECT DISTINCT ON (a."user_id") c2."id"
  FROM "credit_cards" c2
  JOIN "accounts" a ON a."id" = c2."account_id"
  WHERE a."is_active" = true
    AND NOT EXISTS (
      SELECT 1 FROM "credit_cards" p
      JOIN "accounts" pa ON pa."id" = p."account_id"
      WHERE pa."user_id" = a."user_id" AND pa."is_active" = true AND p."is_primary" = true
    )
  ORDER BY a."user_id", c2."created_at" ASC
) AS first_card
WHERE c."id" = first_card."id";
-- backfill:end
