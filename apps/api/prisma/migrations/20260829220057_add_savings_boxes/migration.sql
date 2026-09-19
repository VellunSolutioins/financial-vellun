-- CreateEnum
CREATE TYPE "SavingsYieldPeriod" AS ENUM ('monthly', 'annual');

-- CreateTable
CREATE TABLE "savings_boxes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "target_amount" DECIMAL(15,2),
    "target_date" DATE,
    "yield_rate" DECIMAL(6,3),
    "yield_period" "SavingsYieldPeriod",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "savings_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "savings_contributions" (
    "id" TEXT NOT NULL,
    "savings_box_id" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "contributed_at" DATE NOT NULL,
    "note" TEXT,
    "yield_competence" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "savings_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "savings_boxes_user_id_idx" ON "savings_boxes"("user_id");

-- CreateIndex
CREATE INDEX "savings_contributions_savings_box_id_idx" ON "savings_contributions"("savings_box_id");

-- CreateIndex
CREATE UNIQUE INDEX "savings_contributions_savings_box_id_yield_competence_key" ON "savings_contributions"("savings_box_id", "yield_competence");

-- AddForeignKey
ALTER TABLE "savings_boxes" ADD CONSTRAINT "savings_boxes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "savings_contributions" ADD CONSTRAINT "savings_contributions_savings_box_id_fkey" FOREIGN KEY ("savings_box_id") REFERENCES "savings_boxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

