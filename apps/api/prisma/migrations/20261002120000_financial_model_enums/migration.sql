-- Modelo financeiro pessoal (docs/adrs/0018). Migração própria: um valor novo
-- de enum não pode ser usado na mesma transação em que é criado, e a migração
-- seguinte grava e consulta estes valores.

-- Posição inicial do cartão: dívida e crédito anteriores ao controle.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'opening_debt';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'opening_credit';

-- Empréstimo ou financiamento: conta de passivo.
ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'loan';
