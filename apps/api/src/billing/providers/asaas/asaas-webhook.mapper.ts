import {
  NormalizedWebhookEvent,
  NormalizedWebhookPayment,
  WebhookIntent,
} from '../payment-provider.interface';
import { mapPayment } from './asaas.mapper';
import { AsaasPayment, AsaasWebhookEvent } from './asaas.types';

/** Eventos do Asaas que concedem acesso (pagamento aprovado). */
const SUCCESS_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
/** Eventos do Asaas que indicam inadimplência. */
const FAILURE_EVENTS = new Set(['PAYMENT_OVERDUE']);
const REFUND_EVENTS = new Set(['PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED']);
const CHARGEBACK_EVENTS = new Set([
  'PAYMENT_CHARGEBACK_REQUESTED',
  'PAYMENT_CHARGEBACK_DISPUTE',
  'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
]);
const CANCEL_EVENTS = new Set(['SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED']);

function intentOf(eventType: string): WebhookIntent {
  if (SUCCESS_EVENTS.has(eventType)) return 'payment_succeeded';
  if (FAILURE_EVENTS.has(eventType)) return 'payment_failed';
  if (REFUND_EVENTS.has(eventType)) return 'payment_refunded';
  if (CHARGEBACK_EVENTS.has(eventType)) return 'payment_chargeback';
  if (CANCEL_EVENTS.has(eventType)) return 'subscription_canceled';
  return 'ignore';
}

function toNormalizedPayment(payment: AsaasPayment | undefined): NormalizedWebhookPayment | null {
  if (!payment?.id) return null;
  const mapped = mapPayment(payment);
  return {
    providerPaymentId: mapped.id,
    status: mapped.status,
    amount: mapped.amount,
    currency: mapped.currency,
    dueAt: mapped.dueAt ?? null,
    paidAt: mapped.paidAt ?? null,
  };
}

/** Normaliza um evento do Asaas para o formato interno agnóstico ao PSP. */
export function normalizeAsaasWebhookEvent(
  eventType: string,
  payload: unknown,
): NormalizedWebhookEvent {
  const event = (payload ?? {}) as AsaasWebhookEvent;
  const payment = event.payment;

  return {
    intent: intentOf(eventType),
    providerSubscriptionId: payment?.subscription ?? event.subscription?.id ?? null,
    providerCustomerId: payment?.customer ?? event.subscription?.customer ?? null,
    payment: toNormalizedPayment(payment),
  };
}
