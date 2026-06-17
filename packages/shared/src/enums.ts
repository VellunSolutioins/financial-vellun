export const ProfileType = {
  INDIVIDUAL: 'individual',
  BUSINESS: 'business',
} as const;
export type ProfileType = (typeof ProfileType)[keyof typeof ProfileType];

export const TransactionType = {
  INCOME: 'income',
  EXPENSE: 'expense',
  TRANSFER: 'transfer',
} as const;
export type TransactionType = (typeof TransactionType)[keyof typeof TransactionType];

export const TransactionStatus = {
  CONFIRMED: 'confirmed',
  PENDING: 'pending',
  CANCELLED: 'cancelled',
} as const;
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

export const TransactionSource = {
  MANUAL: 'manual',
  WHATSAPP: 'whatsapp',
  AI: 'ai',
  IMPORT: 'import',
  RECURRING: 'recurring',
} as const;
export type TransactionSource = (typeof TransactionSource)[keyof typeof TransactionSource];

export const AccountType = {
  CHECKING: 'checking',
  SAVINGS: 'savings',
  CASH: 'cash',
  CREDIT_CARD: 'credit_card',
  DIGITAL_WALLET: 'digital_wallet',
  INVESTMENT: 'investment',
  OTHER: 'other',
} as const;
export type AccountType = (typeof AccountType)[keyof typeof AccountType];
