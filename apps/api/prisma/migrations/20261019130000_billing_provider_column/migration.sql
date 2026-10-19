-- PSP de cada linha de billing, e unicidade dos ids do PSP por PSP.
--
-- Até aqui só existia o Asaas, e um id dele era único sozinho. Com dois PSPs no
-- ar — o caso de uma migração, em que as assinaturas antigas continuam no PSP
-- antigo —, ids de PSPs diferentes podem coincidir, e a reconciliação mandaria
-- ao PSP novo ids que são do antigo.
--
-- Tudo o que existe hoje veio do Asaas. Pagamentos e eventos passam a exigir o
-- PSP (sem default: a aplicação grava sempre). Na assinatura o PSP é opcional —
-- nulo quando nenhum participou, como no plano gratuito.

ALTER TABLE "subscriptions" ADD COLUMN "provider" TEXT;
UPDATE "subscriptions"
   SET "provider" = 'asaas'
 WHERE "provider_customer_id" IS NOT NULL
    OR "provider_subscription_id" IS NOT NULL
    OR "provider_checkout_id" IS NOT NULL;

ALTER TABLE "payments" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'asaas';
ALTER TABLE "payments" ALTER COLUMN "provider" DROP DEFAULT;

ALTER TABLE "payment_webhook_events" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'asaas';
ALTER TABLE "payment_webhook_events" ALTER COLUMN "provider" DROP DEFAULT;

DROP INDEX "subscriptions_provider_subscription_id_key";
DROP INDEX "subscriptions_provider_checkout_id_key";
DROP INDEX "payments_provider_payment_id_key";
DROP INDEX "payment_webhook_events_provider_event_id_key";

CREATE UNIQUE INDEX "subscriptions_provider_provider_subscription_id_key" ON "subscriptions"("provider", "provider_subscription_id");
CREATE UNIQUE INDEX "subscriptions_provider_provider_checkout_id_key" ON "subscriptions"("provider", "provider_checkout_id");
CREATE UNIQUE INDEX "payments_provider_provider_payment_id_key" ON "payments"("provider", "provider_payment_id");
CREATE UNIQUE INDEX "payment_webhook_events_provider_provider_event_id_key" ON "payment_webhook_events"("provider", "provider_event_id");
