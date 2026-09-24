import { AccountType } from '@prisma/client';

/**
 * Tipos de conta comum. `credit_card` fica de fora: a conta de um cartão é
 * interna (criada e mantida por `/credit-cards`) e nunca aparece em Contas.
 */
export const REGULAR_ACCOUNT_TYPES = [
  'checking',
  'savings',
  'cash',
  'digital_wallet',
  'investment',
  'other',
] as const satisfies readonly AccountType[];
export type RegularAccountType = (typeof REGULAR_ACCOUNT_TYPES)[number];

/** Filtro Prisma das contas comuns (exclui as contas internas dos cartões). */
export const REGULAR_ACCOUNT_WHERE = { type: { not: 'credit_card' } } as const;
