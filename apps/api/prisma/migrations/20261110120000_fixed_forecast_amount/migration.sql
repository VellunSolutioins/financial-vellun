-- Recorrência (fixo): o valor da ocorrência é previsão e o pagamento registrado
-- é o valor real. Pagar fecha a ocorrência: o `amount` passa a ser o pago e o
-- previsto fica em `forecast_amount`, que a reversão usa para restaurá-lo.

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "forecast_amount" DECIMAL(15,2);

-- Ocorrências fixas "pagas em parte" pela regra antiga passam a pagas pelo que
-- foi liquidado. Cartão fica de fora: quem liquida a compra é a fatura.
UPDATE "transactions" AS t
SET "forecast_amount" = t."amount",
    "amount" = t."settled_amount"
FROM "accounts" AS a
WHERE a."id" = t."account_id"
  AND a."type" <> 'credit_card'
  AND t."recurrence_type" = 'fixo'
  AND t."status" = 'confirmed'
  AND t."type" IN ('income', 'expense', 'refund')
  AND t."settled_amount" > 0
  AND t."settled_amount" < t."amount"
  AND t."forecast_amount" IS NULL;
