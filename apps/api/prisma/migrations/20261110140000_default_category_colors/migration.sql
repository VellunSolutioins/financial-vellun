-- Cores das categorias padrão: Moradia e Lazer eram o mesmo azul, e outros
-- pares eram quase iguais (Transporte × Salário, Alimentação × Juros e tarifas,
-- Vendas × Software...). A paleta nova foi escolhida pela distância perceptual
-- (CIEDE2000): o par mais próximo tem ΔE 15,1 no pessoal e 20,8 na empresa,
-- contra 2,8 antes. Mesmas cores de `prisma/seed.ts`. Só categorias padrão
-- (globais); as criadas pelo usuário mantêm a cor escolhida.
UPDATE "categories" AS c
   SET "color" = v."color", "updated_at" = CURRENT_TIMESTAMP
  FROM (VALUES
    ('Alimentação', 'individual', '#E53935'),
    ('Mercado', 'individual', '#FB8C00'),
    ('Moradia', 'individual', '#1E88E5'),
    ('Transporte', 'individual', '#FDD835'),
    ('Saúde', 'individual', '#00897B'),
    ('Educação', 'individual', '#9CCC65'),
    ('Lazer', 'individual', '#EC407A'),
    ('Salário', 'individual', '#43A047'),
    ('Investimentos', 'individual', '#AB8F3A'),
    ('Outros', 'individual', '#9E9E9E'),
    ('Streaming', 'individual', '#4DB6AC'),
    ('Delivery', 'individual', '#8E24AA'),
    ('Restaurante', 'individual', '#3949AB'),
    ('Fatura do cartão', 'individual', '#546E7A'),
    ('Juros e tarifas', 'individual', '#BA68C8'),
    ('Aquisição de bens', 'individual', '#8D6E63'),
    ('Vendas', 'business', '#43A047'),
    ('Serviços', 'business', '#AB47BC'),
    ('Fornecedores', 'business', '#FB8C00'),
    ('Impostos', 'business', '#E53935'),
    ('Folha de pagamento', 'business', '#00ACC1'),
    ('Aluguel', 'business', '#1E88E5'),
    ('Marketing', 'business', '#3949AB'),
    ('Software', 'business', '#F06292'),
    ('Transporte', 'business', '#FDD835'),
    ('Outros', 'business', '#9E9E9E')
  ) AS v("name", "profile_type", "color")
 WHERE c."user_id" IS NULL
   AND c."is_default"
   AND c."name" = v."name"
   AND c."profile_type"::text = v."profile_type";
