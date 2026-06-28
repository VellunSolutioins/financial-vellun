/**
 * Formas (shapes) da API do Asaas. Estes tipos são **privados ao adapter** e
 * nunca devem vazar para fora desta pasta — o mapper converte tudo para os
 * tipos internos de `payment-provider.interface.ts`.
 */

export interface AsaasCustomer {
  id: string;
  name?: string;
  email?: string;
  cpfCnpj?: string;
}

/** Ciclos de cobrança aceitos pelo Asaas. */
export type AsaasCycle = 'MONTHLY' | 'YEARLY';

/** Status de assinatura no Asaas. */
export type AsaasSubscriptionStatus = 'ACTIVE' | 'EXPIRED' | 'INACTIVE';

export interface AsaasSubscription {
  id: string;
  customer: string;
  status: AsaasSubscriptionStatus;
  cycle: AsaasCycle;
  value: number;
  nextDueDate?: string | null;
  endDate?: string | null;
  deleted?: boolean;
}

/** Status de cobrança no Asaas. */
export type AsaasPaymentStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'RECEIVED'
  | 'RECEIVED_IN_CASH'
  | 'OVERDUE'
  | 'REFUNDED'
  | 'REFUND_REQUESTED'
  | 'REFUND_IN_PROGRESS'
  | 'PARTIALLY_REFUNDED'
  | 'CHARGEBACK_REQUESTED'
  | 'CHARGEBACK_DISPUTE'
  | 'AWAITING_CHARGEBACK_REVERSAL'
  | 'AWAITING_RISK_ANALYSIS'
  | 'DELETED';

export interface AsaasPayment {
  id: string;
  status: AsaasPaymentStatus;
  value: number;
  billingType?: string;
  dueDate?: string | null;
  paymentDate?: string | null;
  confirmedDate?: string | null;
  clientPaymentDate?: string | null;
}

export interface AsaasList<T> {
  data: T[];
  hasMore?: boolean;
  totalCount?: number;
}

export interface AsaasCheckout {
  id: string;
  /** URL hospedada do checkout para redirecionar o usuário. */
  link?: string;
  url?: string;
}

export interface AsaasRefund {
  id?: string;
  status?: string;
}

/** Envelope de evento de webhook do Asaas. */
export interface AsaasWebhookEvent {
  id: string;
  event: string;
  payment?: AsaasPayment & { subscription?: string; customer?: string };
  subscription?: AsaasSubscription;
}
