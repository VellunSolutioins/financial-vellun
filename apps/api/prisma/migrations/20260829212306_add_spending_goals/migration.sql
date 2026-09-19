-- CreateTable
CREATE TABLE "spending_goals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spending_goals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "spending_goals_user_id_idx" ON "spending_goals"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "spending_goals_user_id_category_id_key" ON "spending_goals"("user_id", "category_id");

-- AddForeignKey
ALTER TABLE "spending_goals" ADD CONSTRAINT "spending_goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spending_goals" ADD CONSTRAINT "spending_goals_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

