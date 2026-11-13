-- Números de WhatsApp isentos de assinatura, cadastrados no painel de operações.
--
-- A isenção vale para a conta cujo WhatsApp verificado (`whatsapp_contacts`) é
-- este número. `phone_number` é o E.164 normalizado, a chave da comparação;
-- `phone` guarda o número como cadastrado, mascarado.

-- CreateTable
CREATE TABLE "subscription_exemptions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_operator_id" TEXT,

    CONSTRAINT "subscription_exemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_exemptions_phone_number_key" ON "subscription_exemptions"("phone_number");

-- AddForeignKey
ALTER TABLE "subscription_exemptions" ADD CONSTRAINT "subscription_exemptions_updated_by_operator_id_fkey" FOREIGN KEY ("updated_by_operator_id") REFERENCES "ops_operators"("id") ON DELETE SET NULL ON UPDATE CASCADE;
