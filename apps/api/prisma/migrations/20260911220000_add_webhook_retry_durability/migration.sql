-- Durabilidade do retry de webhook de pagamento (Entrega 8).
--
-- O retry vivia em `setTimeout` no processo (5 tentativas, ~7,5s no total): um
-- deploy dentro dessa janela perdia o evento. O agendamento passa a viver no
-- banco, e um cron varre o que venceu.

-- `exhausted` separa "acabou" de "vai ser retentado sozinho". Sem essa
-- distincao o painel nao consegue dizer se ha algo a fazer, e o operador
-- reprocessaria por cima de um retry em andamento.
ALTER TYPE "WebhookEventStatus" ADD VALUE IF NOT EXISTS 'exhausted';

ALTER TABLE "payment_webhook_events"
  ADD COLUMN IF NOT EXISTS "attempted_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "subscription_id" TEXT;

-- `ON DELETE SET NULL`: apagar uma assinatura nao pode apagar o registro de que
-- o evento chegou. O evento e o que o PSP mandou; continua valendo sem ela.
ALTER TABLE "payment_webhook_events"
  ADD CONSTRAINT "payment_webhook_events_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A varredura do cron.
CREATE INDEX IF NOT EXISTS "payment_webhook_events_status_next_retry_at_idx"
  ON "payment_webhook_events"("status", "next_retry_at");

-- A listagem do painel ordena por data; sem isto, varredura completa.
CREATE INDEX IF NOT EXISTS "payment_webhook_events_received_at_idx"
  ON "payment_webhook_events"("received_at");

CREATE INDEX IF NOT EXISTS "payment_webhook_events_subscription_id_idx"
  ON "payment_webhook_events"("subscription_id");
