-- Parcela do cartão na abertura da fatura (docs/adrs/0022).
--
-- 1. `budget_date`: o mês em que a parcela pesa nos gastos, quando difere da
--    data do lançamento. Nulo = vale `transaction_date`.
ALTER TABLE "transactions" ADD COLUMN "budget_date" DATE;

-- 2. Parcelas 2+ já gravadas em faturas ainda não fechadas passam para o
--    primeiro dia da fatura; a data antiga (compra + n meses) fica em
--    `budget_date`, para o gasto continuar contando uma parcela por mês.
--    Faturas fechadas não mudam. Parcela adiantada fica na data do
--    adiantamento. Só as parcelas atribuídas pelo ciclo da compra (compra a
--    partir do início do controle do cartão), como em `assignInvoices`.
UPDATE "transactions" t
   SET "budget_date" = COALESCE(t."budget_date", t."transaction_date"),
       "transaction_date" = i."period_start"
  FROM "credit_card_invoices" i
  JOIN "credit_cards" c ON c."id" = i."credit_card_id"
 WHERE t."invoice_id" = i."id"
   AND t."recurrence_type" = 'parcelado'
   AND t."type" = 'expense'
   AND t."status" = 'confirmed'
   AND t."series_id" IS NOT NULL
   AND t."installment_number" > 1
   AND t."advanced_at" IS NULL
   AND c."invoice_tracking_start" IS NOT NULL
   AND t."event_date" >= c."invoice_tracking_start"
   AND i."closing_date" > (now() AT TIME ZONE 'America/Sao_Paulo')::date
   AND t."transaction_date" <> i."period_start";
