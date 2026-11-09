-- Cursor do rodízio da reconciliação de billing.
--
-- O lote ordenava por `updated_at`, e assinatura consistente não é alterada:
-- as mesmas 200 ficavam no topo e as demais nunca eram verificadas. A coluna
-- registra quando cada assinatura foi olhada; nula = ainda não foi.
ALTER TABLE "subscriptions" ADD COLUMN "last_reconciled_at" TIMESTAMP(3);
