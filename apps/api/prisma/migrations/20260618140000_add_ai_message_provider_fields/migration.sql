-- AlterTable
ALTER TABLE "ai_messages" ADD COLUMN     "processed_at" TIMESTAMP(3),
ADD COLUMN     "provider_message_id" TEXT,
ADD COLUMN     "provider_timestamp" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "ai_messages_provider_message_id_key" ON "ai_messages"("provider_message_id");

-- CreateIndex
CREATE INDEX "ai_messages_conversation_id_created_at_idx" ON "ai_messages"("conversation_id", "created_at");
