/**
 * Tipos aceitos em lançamentos e categorias. O enum `TransactionType` do Prisma
 * ainda tem `transfer` para não invalidar registros antigos, mas nenhuma
 * entrada da API aceita esse valor.
 */
export const ENTRY_TYPES = ['income', 'expense'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];
