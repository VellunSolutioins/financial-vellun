-- Correlação da assinatura com o checkout hospedado em que foi contratada.
--
-- A assinatura do PSP só passa a existir quando o cliente paga. Até lá, a
-- única ligação entre a linha local e o que acontece no PSP era o cliente — e
-- por ele uma cobrança de outra assinatura do mesmo cliente casava com a linha
-- errada. As cobranças e os eventos de checkout trazem o id do checkout.
--
-- Só acrescenta colunas; linhas existentes ficam com as duas nulas.
ALTER TABLE "subscriptions" ADD COLUMN "provider_checkout_id" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "checkout_expires_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "subscriptions_provider_checkout_id_key" ON "subscriptions"("provider_checkout_id");
