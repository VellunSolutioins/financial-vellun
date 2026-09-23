-- CreateEnum
CREATE TYPE "RecurrenceType" AS ENUM ('avulso', 'fixo', 'parcelado');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('pending', 'paid');

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "installment_number" INTEGER,
ADD COLUMN     "installment_total" INTEGER,
ADD COLUMN     "recurrence_type" "RecurrenceType" NOT NULL DEFAULT 'avulso',
ADD COLUMN     "series_id" TEXT;

-- CreateTable
CREATE TABLE "credit_cards" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "brand" TEXT,
    "color" TEXT,
    "credit_limit" DECIMAL(15,2),
    "due_day" INTEGER NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(15,2),
    "due_date" DATE NOT NULL,
    "is_recurrent" BOOLEAN NOT NULL DEFAULT false,
    "recurrence_end_date" DATE,
    "status" "ReminderStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agenda_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "event_date" DATE NOT NULL,
    "event_time" TEXT,
    "color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agenda_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

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
CREATE UNIQUE INDEX "credit_cards_account_id_key" ON "credit_cards"("account_id");

-- CreateIndex
CREATE INDEX "reminders_user_id_idx" ON "reminders"("user_id");

-- CreateIndex
CREATE INDEX "agenda_events_user_id_idx" ON "agenda_events"("user_id");

-- CreateIndex
CREATE INDEX "notes_user_id_idx" ON "notes"("user_id");

-- CreateIndex
CREATE INDEX "spending_goals_user_id_idx" ON "spending_goals"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "spending_goals_user_id_category_id_key" ON "spending_goals"("user_id", "category_id");

-- CreateIndex
CREATE INDEX "transactions_series_id_idx" ON "transactions"("series_id");

-- CreateIndex
CREATE INDEX "transactions_user_id_recurrence_type_transaction_date_idx" ON "transactions"("user_id", "recurrence_type", "transaction_date");

-- AddForeignKey
ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agenda_events" ADD CONSTRAINT "agenda_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spending_goals" ADD CONSTRAINT "spending_goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spending_goals" ADD CONSTRAINT "spending_goals_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

