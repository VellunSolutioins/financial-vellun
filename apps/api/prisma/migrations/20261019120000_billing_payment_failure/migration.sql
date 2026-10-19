-- Última cobrança recusada da assinatura: quando e por quê (código genérico,
-- `card_refused` ou `risk_rejected`). A tela usa para explicar a recusa; um
-- pagamento aprovado limpa os dois. Só acrescenta colunas.
ALTER TABLE "subscriptions" ADD COLUMN "last_payment_failure_at" TIMESTAMP(3);
ALTER TABLE "subscriptions" ADD COLUMN "last_payment_failure_reason" TEXT;
