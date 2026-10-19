import type { PaymentFailureReason } from '@financial-vellun/shared';
import { BillingInterval } from '@prisma/client';

/**
 * Token de injeção do provider de pagamento. O adapter concreto é escolhido no
 * billing.module pela variável `PAYMENT_PROVIDER`.
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

// ── Tipos internos ──────────────────────────────────────────────────────────
// Nenhum tipo do SDK/HTTP do PSP deve vazar para fora do adapter. A camada de
// domínio trabalha apenas com os contratos abaixo, e as falhas chegam como
// `PaymentProviderError` (payment-provider.errors.ts).

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
  /** Id da assinatura local, gravado no PSP para rastrear o checkout de volta. */
  externalReference: string;
}

export interface CheckoutSession {
  checkoutUrl: string;
  providerCheckoutId?: string;
  /** Até quando o checkout aceita pagamento. */
  expiresAt?: Date | null;
}

/**
 * Interrompe as cobranças futuras da assinatura no PSP. Manter o acesso até o
 * fim do período pago é regra do domínio, não do PSP.
 */
export interface CancelSubscriptionInput {
  providerSubscriptionId: string;
}

/** Estado de uma assinatura no PSP, em termos do domínio. */
export type ProviderSubscriptionStatus = 'active' | 'inactive' | 'canceled' | 'expired';

/** Estado de uma cobrança no PSP, em termos do domínio (os mesmos do banco). */
export type ProviderPaymentStatus =
  | 'pending'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'chargeback'
  | 'canceled';

/** Dado do cadastro do cliente que um PSP pode exigir para cobrar no cartão. */
export type CustomerProfileField =
  | 'phone'
  | 'document'
  | 'postalCode'
  | 'street'
  | 'addressNumber'
  | 'neighborhood';

export interface ProviderSubscription {
  id: string;
  status: ProviderSubscriptionStatus;
  /**
   * Vencimento da próxima cobrança **a ser gerada** pelo PSP. Não é o fim do
   * período pago: o PSP pode gerar cobranças com antecedência (o Asaas gera
   * ~40 dias antes), e aí esta data fica um ou dois ciclos à frente. O período
   * pago se deriva da cobrança, em `SubscriptionStateService.effectOfCharge`.
   */
  nextDueAt?: Date | null;
  cancelAtPeriodEnd?: boolean;
  /** A quem a assinatura pertence e em que checkout foi contratada. */
  providerCustomerId?: string | null;
  providerCheckoutId?: string | null;
  /** Ciclo de cobrança; nulo quando o PSP usa um que não oferecemos. */
  interval?: BillingInterval | null;
}

export interface ProviderPayment {
  id: string;
  status: ProviderPaymentStatus;
  amount: string;
  currency: string;
  dueAt?: Date | null;
  paidAt?: Date | null;
  /** Vínculos da cobrança no PSP — é por eles que se acha a assinatura local. */
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  /** Checkout em que a assinatura foi contratada; vem em todas as cobranças dela. */
  providerCheckoutId: string | null;
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
  /** PSP que mandou o evento (o `name` do adapter). */
  provider: string;
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
  | 'subscription_created'
  | 'checkout_expired'
  /** Cobrança recusada (cartão, análise de risco). Ver `paymentFailureReason`. */
  | 'payment_refused'
  /** Cobrança alterada, removida ou restaurada: só espelha o estado do PSP. */
  | 'payment_updated'
  | 'ignore';

export type { PaymentFailureReason };

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
  providerCheckoutId: string | null;
  payment: NormalizedWebhookPayment | null;
  /** Só em `payment_refused`. */
  paymentFailureReason: PaymentFailureReason | null;
}

/**
 * Único contrato que controllers, guards e serviços de domínio conhecem.
 * Implementado pelo adapter do PSP (Prompt 3).
 */
export interface PaymentProvider {
  /** Identifica o PSP nas linhas que ele origina (`provider` no banco). */
  readonly name: string;
  /**
   * Dados do cadastro que o PSP exige antes de criar o cliente. O domínio
   * valida a partir desta lista, para devolver ao usuário o que falta em vez
   * de uma recusa genérica do PSP.
   */
  readonly requiredCustomerFields: readonly CustomerProfileField[];
  /**
   * Devolve o cliente do usuário no PSP, criando se ainda não existir. Repetir
   * a chamada para o mesmo `userId` não pode criar um segundo cliente.
   */
  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  cancelSubscription(input: CancelSubscriptionInput): Promise<void>;
  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscription>;
  /**
   * Estado atual de uma cobrança no PSP. O webhook só avisa que algo mudou; o
   * que vale é o que esta consulta devolve.
   */
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
  listSubscriptionPayments(providerSubscriptionId: string): Promise<ProviderPayment[]>;
  refundPayment(input: RefundPaymentInput): Promise<ProviderRefund>;
  verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedPaymentEvent>;
  /** Traduz um evento verificado do PSP para a intenção de negócio interna. */
  normalizeWebhookEvent(event: VerifiedPaymentEvent): NormalizedWebhookEvent;
}
