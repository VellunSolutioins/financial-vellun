export const ProfileType = {
  INDIVIDUAL: 'individual',
  BUSINESS: 'business',
} as const;
export type ProfileType = (typeof ProfileType)[keyof typeof ProfileType];

export const TransactionType = {
  INCOME: 'income',
  EXPENSE: 'expense',
} as const;
export type TransactionType = (typeof TransactionType)[keyof typeof TransactionType];

export const TransactionStatus = {
  CONFIRMED: 'confirmed',
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

// ── Billing ───────────────────────────────────────────────────────────────

export const SubscriptionStatus = {
  PENDING: 'pending',
  TRIALING: 'trialing',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
  UNPAID: 'unpaid',
  EXPIRED: 'expired',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export const PaymentStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
  CHARGEBACK: 'chargeback',
  CANCELED: 'canceled',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const BillingInterval = {
  MONTHLY: 'monthly',
  ANNUAL: 'annual',
} as const;
export type BillingInterval = (typeof BillingInterval)[keyof typeof BillingInterval];

export const PaymentMethodType = {
  CREDIT_CARD: 'credit_card',
} as const;
export type PaymentMethodType = (typeof PaymentMethodType)[keyof typeof PaymentMethodType];

export const WebhookEventStatus = {
  RECEIVED: 'received',
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  FAILED: 'failed',
} as const;
export type WebhookEventStatus = (typeof WebhookEventStatus)[keyof typeof WebhookEventStatus];
