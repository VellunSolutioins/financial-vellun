-- Gasto fixo é sempre previsão: o valor da ocorrência é estimativa e o
-- pagamento registrado é o valor real (ver `fixed_forecast_amount`). A marca
-- deixou de ser escolha do usuário; as ocorrências ainda não pagas criadas como
-- conta a pagar passam a previsão. As já pagas ficam como estão: pagar torna a
-- ocorrência realizada. No cartão a marca não tem efeito (vale a data).
UPDATE "transactions"
SET "forecast" = true
WHERE "recurrence_type" = 'fixo'
  AND "forecast" = false
  AND "settled_amount" = 0;
