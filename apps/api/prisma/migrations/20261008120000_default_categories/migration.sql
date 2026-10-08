-- Categorias padrão novas do perfil pessoal e a categoria dos pagamentos de
-- fatura (docs/adrs/0021). Só acrescenta dados; não altera estrutura.

-- 1. Categorias padrão. Idempotente: o seed cria as mesmas, e um dos dois
--    chega primeiro.
INSERT INTO "categories" ("id", "user_id", "name", "type", "color", "profile_type", "is_default", "created_at", "updated_at")
SELECT gen_random_uuid()::text, NULL, v."name", 'expense', v."color", 'individual', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM (VALUES
    ('Streaming', '#B39DDB'),
    ('Delivery', '#FFB74D'),
    ('Restaurante', '#F48FB1'),
    ('Fatura do cartão', '#90A4AE')
  ) AS v("name", "color")
 WHERE NOT EXISTS (
   SELECT 1 FROM "categories" c
    WHERE c."user_id" IS NULL AND c."is_default" AND c."name" = v."name"
      AND c."type" = 'expense' AND c."profile_type" = 'individual'
 );

-- 2. Pagamentos de fatura já gravados (as duas pernas) passam a ter a
--    categoria "Fatura do cartão". Só preenche onde está vazio.
UPDATE "transactions" t
   SET "category_id" = c."id"
  FROM "categories" c
 WHERE t."card_payment_id" IS NOT NULL
   AND t."type" = 'transfer'
   AND t."category_id" IS NULL
   AND c."user_id" IS NULL AND c."is_default" AND c."name" = 'Fatura do cartão'
   AND c."type" = 'expense' AND c."profile_type" = 'individual';
