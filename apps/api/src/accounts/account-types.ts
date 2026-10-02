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
  'loan',
  'other',
] as const satisfies readonly AccountType[];
export type RegularAccountType = (typeof REGULAR_ACCOUNT_TYPES)[number];

/**
 * Contas de caixa: dinheiro disponível. É a soma delas o "Saldo atual em
 * contas". Investimento e empréstimo aparecem à parte (docs/adrs/0018) — um
 * aporte tira dinheiro do caixa sem ser gasto, e a conta de empréstimo é dívida.
 */
export const CASH_ACCOUNT_TYPES = [
  'checking',
  'savings',
  'cash',
  'digital_wallet',
  'other',
] as const satisfies readonly AccountType[];

/** Filtro Prisma das contas comuns (exclui as contas internas dos cartões). */
export const REGULAR_ACCOUNT_WHERE = { type: { not: 'credit_card' } } as const;
