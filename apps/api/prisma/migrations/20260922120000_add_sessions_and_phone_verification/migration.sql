-- Sessões revogáveis e verificação de posse do WhatsApp (plano de segurança, S1).
--
-- Contatos já vinculados continuam com is_verified = true: são tratados como
-- vínculo legado (verified_at nulo) e seguem identificando o usuário. Todo
-- vínculo novo passa pelo desafio de posse em phone_verifications.
--
-- Os tokens emitidos antes desta versão não têm sessão (sid) e deixam de ser
-- aceitos: cada usuário precisa entrar de novo uma vez.

-- AlterTable
ALTER TABLE "whatsapp_contacts" ADD COLUMN     "link_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "revoked_at" TIMESTAMP(3),
ADD COLUMN     "verified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "previous_token_hash" TEXT,
    "rotated_at" TIMESTAMP(3),
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_verifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "display_phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "phone_verifications_user_id_created_at_idx" ON "phone_verifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "phone_verifications_phone_number_idx" ON "phone_verifications"("phone_number");

-- CreateIndex
CREATE INDEX "whatsapp_contacts_user_id_idx" ON "whatsapp_contacts"("user_id");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

