import { BillingInterval } from '@prisma/client';

/**
 * Token de injeção do provider de pagamento. O bind para o adapter concreto
 * (ex.: AsaasPaymentProvider) acontece no billing.module no Prompt 3.
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

// ── Tipos internos ──────────────────────────────────────────────────────────
// Nenhum tipo do SDK/HTTP do PSP deve vazar para fora do adapter. A camada de
// domínio trabalha apenas com os contratos abaixo.

export interface ProviderCustomer {
  id: string;
}

export interface CreateCustomerInput {
  userId: string;
  name: string;
  email: string;
  phone?: string | null;
  document?: string | null;
  /** Endereço de cobrança. `city`/`state` são derivados do CEP pelo provedor. */
  postalCode?: string | null;
  street?: string | null;
  addressNumber?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
}

export interface CreateCheckoutInput {
  userId: string;
  planCode: string;
  providerCustomerId: string;
  interval: BillingInterval;
  amount: string;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  checkoutUrl: string;
  providerCheckoutId?: string;
}

export interface PaymentMethodUpdateInput {
  providerCustomerId: string;
  providerSubscriptionId: string;
  returnUrl: string;
}

export interface PaymentMethodUpdateSession {
  url: string;
}

export interface CancelSubscriptionInput {
  providerSubscriptionId: string;
  cancelAtPeriodEnd: boolean;
}

export interface ProviderSubscription {
  id: string;
  status: string;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
}

export interface ProviderPayment {
  id: string;
  status: string;
  amount: string;
  currency: string;
  dueAt?: Date | null;
  paidAt?: Date | null;
}

export interface RefundPaymentInput {
  providerPaymentId: string;
  amount?: string;
}

export interface ProviderRefund {
  id: string;
  status: string;
}

export interface VerifyWebhookInput {
  rawBody: Buffer | string;
  signature?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export interface VerifiedPaymentEvent {
  providerEventId: string;
  eventType: string;
  payload: unknown;
}

/** Intenção de negócio normalizada a partir de um evento do PSP. */
export type WebhookIntent =
  | 'payment_succeeded'
  | 'payment_failed'
  | 'payment_refunded'
  | 'payment_chargeback'
  | 'subscription_canceled'
  | 'ignore';

export interface NormalizedWebhookPayment {
  providerPaymentId: string;
  status: string;
  amount: string;
  currency: string;
  dueAt: Date | null;
  paidAt: Date | null;
}

/**
 * Evento do PSP traduzido para termos internos. O processador de webhook
 * trabalha apenas com este formato — nunca com o payload bruto do PSP.
 */
export interface NormalizedWebhookEvent {
  intent: WebhookIntent;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  payment: NormalizedWebhookPayment | null;
}

/**
 * Único contrato que controllers, guards e serviços de domínio conhecem.
 * Implementado pelo adapter do PSP (Prompt 3).
 */
export interface PaymentProvider {
  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  createPaymentMethodUpdateSession(
    input: PaymentMethodUpdateInput,
  ): Promise<PaymentMethodUpdateSession>;
  cancelSubscription(input: CancelSubscriptionInput): Promise<void>;
  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscription>;
  listSubscriptionPayments(providerSubscriptionId: string): Promise<ProviderPayment[]>;
  refundPayment(input: RefundPaymentInput): Promise<ProviderRefund>;
  verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedPaymentEvent>;
  /** Traduz um evento verificado do PSP para a intenção de negócio interna. */
  normalizeWebhookEvent(event: VerifiedPaymentEvent): NormalizedWebhookEvent;
}
