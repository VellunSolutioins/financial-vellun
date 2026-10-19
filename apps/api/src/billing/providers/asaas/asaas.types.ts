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
  deleted?: boolean;
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
  /** Checkout hospedado em que a assinatura foi contratada. */
  checkoutSession?: string | null;
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
  /** Data do crédito na conta. No cartão, ~32 dias depois de `confirmedDate`. */
  paymentDate?: string | null;
  /** Data em que o pagamento foi efetuado. */
  confirmedDate?: string | null;
  clientPaymentDate?: string | null;
  subscription?: string | null;
  customer?: string | null;
  /** Checkout hospedado que originou a cobrança. */
  checkoutSession?: string | null;
  deleted?: boolean;
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
  status?: string;
  /** Cliente do checkout. A documentação não diz se vem o id ou o objeto; aceitamos os dois. */
  customer?: string | { id?: string } | null;
}

export interface AsaasRefund {
  id?: string;
  status?: string;
}

/** Envelope de evento de webhook do Asaas. */
export interface AsaasWebhookEvent {
  id: string;
  event: string;
  payment?: AsaasPayment;
  subscription?: AsaasSubscription;
  checkout?: AsaasCheckout;
}
