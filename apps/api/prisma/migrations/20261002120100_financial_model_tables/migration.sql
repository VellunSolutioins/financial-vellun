-- Modelo financeiro pessoal: gasto, previsão, obrigação e liquidação
-- (docs/adrs/0018-gasto-obrigacao-liquidacao.md).
--
-- Tudo aqui é aditivo. O backfill no fim é idempotente (`NOT EXISTS` /
-- `IS NULL`) e foi escrito para que o saldo de cada conta comum calculado pela
-- regra nova (liquidações + transferências) seja **igual** ao saldo gravado
-- pela regra antiga (lançamentos confirmados com data até hoje). O script
-- `pnpm --filter @financial-vellun/api db:verify:financial-model` confere isso
-- sem escrever nada.

-- CreateEnum
CREATE TYPE "CategoryNature" AS ENUM ('consumption', 'asset_acquisition', 'financial_cost');

-- CreateEnum
CREATE TYPE "SettlementKind" AS ENUM ('payment', 'write_off');

-- CreateEnum
CREATE TYPE "MovementStatus" AS ENUM ('active', 'reversed');

-- CreateEnum
CREATE TYPE "SettlementOrigin" AS ENUM ('user', 'at_sight', 'whatsapp', 'legacy_recorded', 'legacy_matured');

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "nature" "CategoryNature" NOT NULL DEFAULT 'consumption';

-- AlterTable: `event_date` nasce nula, é preenchida pelo backfill e só então
-- vira obrigatória.
ALTER TABLE "transactions" ADD COLUMN     "account_transfer_id" TEXT,
ADD COLUMN     "event_date" DATE,
ADD COLUMN     "forecast" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "purchase_id" TEXT,
ADD COLUMN     "settled_amount" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "installment_purchases" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "category_id" TEXT,
    "type" "TransactionType" NOT NULL,
    "description" TEXT NOT NULL,
    "purchase_date" DATE NOT NULL,
    "total_amount" DECIMAL(15,2) NOT NULL,
    "installment_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installment_purchases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "installment_purchases_total_positive" CHECK ("total_amount" > 0),
    CONSTRAINT "installment_purchases_count_range" CHECK ("installment_count" BETWEEN 1 AND 72)
);

-- CreateTable
CREATE TABLE "transaction_settlements" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "account_id" TEXT,
    "amount" DECIMAL(15,2) NOT NULL,
    "settled_on" DATE NOT NULL,
    "kind" "SettlementKind" NOT NULL DEFAULT 'payment',
    "status" "MovementStatus" NOT NULL DEFAULT 'active',
    "origin" "SettlementOrigin" NOT NULL DEFAULT 'user',
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "reviewed_at" TIMESTAMP(3),
    "idempotency_key" TEXT,
    "reversed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transaction_settlements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transaction_settlements_amount_positive" CHECK ("amount" > 0),
    -- Pagamento move dinheiro de uma conta; dispensa não move.
    CONSTRAINT "transaction_settlements_account_by_kind" CHECK (
      ("kind" = 'payment' AND "account_id" IS NOT NULL) OR
      ("kind" = 'write_off' AND "account_id" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "account_transfers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "from_account_id" TEXT NOT NULL,
    "to_account_id" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "transfer_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "fee_transaction_id" TEXT,
    "status" "MovementStatus" NOT NULL DEFAULT 'active',
    "idempotency_key" TEXT NOT NULL,
    "reversed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_transfers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "account_transfers_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "account_transfers_distinct_accounts" CHECK ("from_account_id" <> "to_account_id")
);

-- CreateIndex
CREATE INDEX "installment_purchases_user_id_purchase_date_idx" ON "installment_purchases"("user_id", "purchase_date");

-- CreateIndex
CREATE INDEX "installment_purchases_account_id_idx" ON "installment_purchases"("account_id");

-- CreateIndex
CREATE INDEX "installment_purchases_category_id_idx" ON "installment_purchases"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_settlements_idempotency_key_key" ON "transaction_settlements"("idempotency_key");

-- CreateIndex
CREATE INDEX "transaction_settlements_transaction_id_idx" ON "transaction_settlements"("transaction_id");

-- CreateIndex
CREATE INDEX "transaction_settlements_account_id_status_idx" ON "transaction_settlements"("account_id", "status");

-- CreateIndex
CREATE INDEX "transaction_settlements_user_id_settled_on_idx" ON "transaction_settlements"("user_id", "settled_on");

-- CreateIndex
CREATE INDEX "transaction_settlements_user_id_needs_review_idx" ON "transaction_settlements"("user_id", "needs_review");

-- CreateIndex
CREATE UNIQUE INDEX "account_transfers_fee_transaction_id_key" ON "account_transfers"("fee_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_transfers_idempotency_key_key" ON "account_transfers"("idempotency_key");

-- CreateIndex
CREATE INDEX "account_transfers_user_id_transfer_date_idx" ON "account_transfers"("user_id", "transfer_date");

-- CreateIndex
CREATE INDEX "account_transfers_from_account_id_idx" ON "account_transfers"("from_account_id");

-- CreateIndex
CREATE INDEX "account_transfers_to_account_id_idx" ON "account_transfers"("to_account_id");

-- CreateIndex
CREATE INDEX "transactions_user_id_event_date_idx" ON "transactions"("user_id", "event_date");

-- CreateIndex
CREATE INDEX "transactions_purchase_id_idx" ON "transactions"("purchase_id");

-- CreateIndex
CREATE INDEX "transactions_account_transfer_id_idx" ON "transactions"("account_transfer_id");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "installment_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_transfer_id_fkey" FOREIGN KEY ("account_transfer_id") REFERENCES "account_transfers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_purchases" ADD CONSTRAINT "installment_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_purchases" ADD CONSTRAINT "installment_purchases_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_purchases" ADD CONSTRAINT "installment_purchases_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_settlements" ADD CONSTRAINT "transaction_settlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_settlements" ADD CONSTRAINT "transaction_settlements_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_settlements" ADD CONSTRAINT "transaction_settlements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_fee_transaction_id_fkey" FOREIGN KEY ("fee_transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill ────────────────────────────────────────────────────────────────
-- "Hoje" é o dia-calendário de America/Sao_Paulo, o mesmo corte que a regra
-- antiga de saldo usava.
--
-- Os comandos entre `@backfill-start` e `@backfill-end` só tocam lançamentos
-- dos usuários em "fm_backfill_users" (aqui, todos). O teste de integração
-- `legacy-migration.integration.spec.ts` executa exatamente esses comandos,
-- lidos deste arquivo, com a tabela restrita ao usuário de teste: o SQL
-- testado é o da migração, e o teste não toca dados de outros testes.
CREATE TEMP TABLE "fm_backfill_users" AS SELECT "id" FROM "users";

-- @backfill-start

-- 1. Uma compra por série parcelada. A data da compra é a da parcela 1 (antes
--    de um eventual adiantamento). Sem a parcela 1 (excluída), recua a menor
--    parcela existente (n − 1) meses — aproximação, listada pelo verify.
--    O total é a soma das parcelas de qualquer status, antes de desconto.
INSERT INTO "installment_purchases"
  ("id", "user_id", "account_id", "category_id", "type", "description",
   "purchase_date", "total_amount", "installment_count", "created_at", "updated_at")
SELECT s."series_id",
       f."user_id",
       f."account_id",
       f."category_id",
       f."type",
       f."description",
       (COALESCE(f."advanced_from_date", f."transaction_date")
          - make_interval(months => COALESCE(f."installment_number", 1) - 1))::date,
       s."total",
       LEAST(72, GREATEST(1, COALESCE(f."installment_total", s."count"::int))),
       s."created_at",
       CURRENT_TIMESTAMP
  FROM (
    SELECT "series_id",
           SUM(COALESCE("amount_before_advance", "amount")) AS "total",
           COUNT(*) AS "count",
           MIN("created_at") AS "created_at"
      FROM "transactions"
     WHERE "recurrence_type" = 'parcelado' AND "series_id" IS NOT NULL
       AND "user_id" IN (SELECT "id" FROM "fm_backfill_users")
     GROUP BY "series_id"
  ) s
  JOIN LATERAL (
    SELECT *
      FROM "transactions" t
     WHERE t."series_id" = s."series_id" AND t."recurrence_type" = 'parcelado'
     ORDER BY t."installment_number" ASC NULLS LAST, t."transaction_date" ASC
     LIMIT 1
  ) f ON TRUE
 WHERE s."total" > 0
   AND NOT EXISTS (SELECT 1 FROM "installment_purchases" p WHERE p."id" = s."series_id");

-- 2. Parcelas apontam para a compra; o fato econômico de cada uma é a compra.
UPDATE "transactions" t
   SET "purchase_id" = p."id",
       "event_date" = p."purchase_date"
  FROM "installment_purchases" p
 WHERE t."series_id" = p."id"
   AND t."recurrence_type" = 'parcelado'
   AND t."purchase_id" IS NULL
   AND t."user_id" IN (SELECT "id" FROM "fm_backfill_users");

-- Todo o resto: o fato é a própria data do lançamento.
UPDATE "transactions" SET "event_date" = "transaction_date"
 WHERE "event_date" IS NULL
   AND "user_id" IN (SELECT "id" FROM "fm_backfill_users");

-- 3. Ocorrências futuras de recorrência são previsão, não obrigação.
UPDATE "transactions"
   SET "forecast" = TRUE
 WHERE "recurrence_type" = 'fixo'
   AND "type" IN ('income', 'expense')
   AND "status" = 'confirmed'
   AND "settled_amount" = 0
   AND "transaction_date" > (now() AT TIME ZONE 'America/Sao_Paulo')::date
   AND "user_id" IN (SELECT "id" FROM "fm_backfill_users");

-- 4. Liquidações que preservam o saldo de hoje. A regra antiga somava todo
--    receita/despesa/estorno confirmado de conta comum com data até hoje; cada
--    um vira uma liquidação do valor cheio, na data dele.
--    - `legacy_recorded`: registrado no dia do fato ou depois (o usuário
--      lançou algo que já tinha acontecido), estorno, ou parcela adiantada;
--    - `legacy_matured`: registrado antes da data e "amadurecido" pelo
--      scheduler — ninguém confirmou o pagamento. Fica para revisão.
INSERT INTO "transaction_settlements"
  ("id", "user_id", "transaction_id", "account_id", "amount", "settled_on",
   "kind", "status", "origin", "needs_review", "created_at", "updated_at")
SELECT gen_random_uuid()::text,
       t."user_id",
       t."id",
       t."account_id",
       t."amount",
       t."transaction_date",
       'payment',
       'active',
       CASE WHEN m."matured" THEN 'legacy_matured' ELSE 'legacy_recorded' END::"SettlementOrigin",
       m."matured",
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
  FROM "transactions" t
  JOIN "accounts" a ON a."id" = t."account_id"
  CROSS JOIN LATERAL (
    SELECT NOT (
      t."type" = 'refund'
      OR t."advanced_at" IS NOT NULL
      OR ((t."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= t."transaction_date"
    ) AS "matured"
  ) m
 WHERE a."type" <> 'credit_card'
   AND t."status" = 'confirmed'
   AND t."type" IN ('income', 'expense', 'refund')
   AND t."amount" > 0
   AND t."transaction_date" <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
   AND t."user_id" IN (SELECT "id" FROM "fm_backfill_users")
   AND NOT EXISTS (SELECT 1 FROM "transaction_settlements" s WHERE s."transaction_id" = t."id");

-- 5. Cache do liquidado.
UPDATE "transactions" t
   SET "settled_amount" = s."total"
  FROM (
    SELECT "transaction_id", SUM("amount") AS "total"
      FROM "transaction_settlements"
     WHERE "status" = 'active'
       AND "user_id" IN (SELECT "id" FROM "fm_backfill_users")
     GROUP BY "transaction_id"
  ) s
 WHERE t."id" = s."transaction_id"
   AND t."settled_amount" <> s."total";

-- Uma ocorrência liquidada já aconteceu: deixa de ser previsão.
UPDATE "transactions" SET "forecast" = FALSE
 WHERE "forecast" AND "settled_amount" > 0
   AND "user_id" IN (SELECT "id" FROM "fm_backfill_users");

-- @backfill-end

DROP TABLE "fm_backfill_users";

ALTER TABLE "transactions" ALTER COLUMN "event_date" SET NOT NULL;

-- O cache nunca passa do valor do lançamento (nem fica negativo). Vem depois
-- do backfill: é o banco recusando liquidação acima do restante, mesmo numa
-- corrida que escape da trava do serviço.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_settled_amount_range"
  CHECK ("settled_amount" >= 0 AND "settled_amount" <= "amount");

-- 6. Categorias padrão de natureza própria (perfil pessoal). Idempotente: o
--    seed cria as mesmas, e um dos dois chega primeiro.
INSERT INTO "categories" ("id", "user_id", "name", "type", "color", "nature", "profile_type", "is_default", "created_at", "updated_at")
SELECT gen_random_uuid()::text, NULL, v."name", 'expense', v."color", v."nature"::"CategoryNature", 'individual', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM (VALUES
    ('Juros e tarifas', '#E57373', 'financial_cost'),
    ('Aquisição de bens', '#A1887F', 'asset_acquisition')
  ) AS v("name", "color", "nature")
 WHERE NOT EXISTS (
   SELECT 1 FROM "categories" c
    WHERE c."user_id" IS NULL AND c."is_default" AND c."name" = v."name"
      AND c."type" = 'expense' AND c."profile_type" = 'individual'
 );
