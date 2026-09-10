-- CreateEnum
CREATE TYPE "OpsFailureSource" AS ENUM ('whatsapp_inbound', 'whatsapp_processing');

-- CreateEnum
CREATE TYPE "OpsFailureStatus" AS ENUM ('pending', 'reprocessing', 'reprocessed', 'discarded');

-- CreateTable
CREATE TABLE "ops_failed_messages" (
    "id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "source" "OpsFailureSource" NOT NULL,
    "source_queue" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "correlation_id" TEXT,
    "provider_message_id" TEXT,
    "job_id" TEXT,
    "phone_hash" TEXT,
    "error_type" TEXT NOT NULL,
    "error_message" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "permanent" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "status" "OpsFailureStatus" NOT NULL DEFAULT 'pending',
    "first_failed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3) NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retention_until" TIMESTAMP(3) NOT NULL,
    "reprocessed_at" TIMESTAMP(3),
    "last_operation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_failed_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_failed_messages_dedupe_key_key" ON "ops_failed_messages"("dedupe_key");

-- CreateIndex
CREATE INDEX "ops_failed_messages_status_captured_at_idx" ON "ops_failed_messages"("status", "captured_at");

-- CreateIndex
CREATE INDEX "ops_failed_messages_captured_at_idx" ON "ops_failed_messages"("captured_at");

-- CreateIndex
CREATE INDEX "ops_failed_messages_correlation_id_idx" ON "ops_failed_messages"("correlation_id");

-- CreateIndex
CREATE INDEX "ops_failed_messages_error_type_idx" ON "ops_failed_messages"("error_type");

-- CreateIndex
CREATE INDEX "ops_failed_messages_phone_hash_idx" ON "ops_failed_messages"("phone_hash");

-- CreateIndex
CREATE INDEX "ops_failed_messages_retention_until_idx" ON "ops_failed_messages"("retention_until");
