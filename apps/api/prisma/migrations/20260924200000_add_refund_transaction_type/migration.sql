-- Estorno como tipo de lançamento (fase 4). Migração própria: um valor novo de
-- enum não pode ser usado na mesma transação em que é criado.
ALTER TYPE "TransactionType" ADD VALUE 'refund';
