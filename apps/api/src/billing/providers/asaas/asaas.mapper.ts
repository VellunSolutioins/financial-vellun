import { BillingInterval } from '@prisma/client';

import {
  ProviderPayment,
  ProviderPaymentStatus,
  ProviderSubscription,
  ProviderSubscriptionStatus,
} from '../payment-provider.interface';
import {
  AsaasCycle,
  AsaasPayment,
  AsaasPaymentStatus,
  AsaasSubscription,
  AsaasSubscriptionStatus,
} from './asaas.types';

/** Converte a periodicidade interna para o ciclo do Asaas. */
export function toAsaasCycle(interval: BillingInterval): AsaasCycle {
  return interval === BillingInterval.annual ? 'YEARLY' : 'MONTHLY';
}

/** Ciclo do Asaas para a periodicidade interna; nulo para os que não oferecemos. */
export function fromAsaasCycle(cycle: AsaasCycle | string | undefined): BillingInterval | null {
  if (cycle === 'MONTHLY') return BillingInterval.monthly;
  if (cycle === 'YEARLY') return BillingInterval.annual;
  return null;
}

/** Status interno normalizado de assinatura derivado do Asaas. */
export function mapSubscriptionStatus(
  status: AsaasSubscriptionStatus,
  deleted?: boolean,
): ProviderSubscriptionStatus {
  if (deleted) return 'canceled';
  switch (status) {
    case 'ACTIVE':
      return 'active';
    case 'EXPIRED':
      return 'expired';
    case 'INACTIVE':
    default:
      return 'inactive';
  }
}

/** Status interno normalizado de pagamento derivado do Asaas. */
export function mapPaymentStatus(status: AsaasPaymentStatus): ProviderPaymentStatus {
  switch (status) {
    case 'CONFIRMED':
    case 'RECEIVED':
    case 'RECEIVED_IN_CASH':
      return 'paid';
    case 'PENDING':
    case 'AWAITING_RISK_ANALYSIS':
      return 'pending';
    case 'OVERDUE':
      return 'failed';
    // Estorno pedido ou em andamento ainda pode ser negado, e o dinheiro segue
    // conosco até ser concluído: a cobrança continua paga. `refunded` cancela a
    // assinatura no PSP, e isso não se desfaz — só o estorno concluído conta.
    case 'REFUND_REQUESTED':
    case 'REFUND_IN_PROGRESS':
      return 'paid';
    case 'REFUNDED':
      return 'refunded';
    case 'PARTIALLY_REFUNDED':
      return 'partially_refunded';
    case 'CHARGEBACK_REQUESTED':
    case 'CHARGEBACK_DISPUTE':
    case 'AWAITING_CHARGEBACK_REVERSAL':
      return 'chargeback';
    case 'DELETED':
      return 'canceled';
    default:
      return 'processing';
  }
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  // Datas "date-only" do Asaas (`YYYY-MM-DD`, ex.: nextDueDate/dueDate)
  // representam um DIA de calendário. `new Date('2026-07-30')` seria interpretado
  // como meia-noite UTC, que em fusos negativos (America/Sao_Paulo, UTC-3) recua
  // para o dia anterior ao ser exibido. Ancoramos ao meio-dia UTC para preservar
  // o dia em qualquer fuso (UTC-11..UTC+11).
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T12:00:00Z`);
  }
  return new Date(value);
}

export function mapSubscription(sub: AsaasSubscription): ProviderSubscription {
  return {
    id: sub.id,
    status: mapSubscriptionStatus(sub.status, sub.deleted),
    nextDueAt: parseDate(sub.nextDueDate),
    cancelAtPeriodEnd: sub.deleted ?? false,
    providerCustomerId: sub.customer ?? null,
    providerCheckoutId: sub.checkoutSession ?? null,
    interval: fromAsaasCycle(sub.cycle),
  };
}

export function mapPayment(payment: AsaasPayment): ProviderPayment {
  return {
    id: payment.id,
    // Cobrança removida continua consultável, com o status que tinha. Para o
    // domínio ela deixou de existir.
    status: payment.deleted ? 'canceled' : mapPaymentStatus(payment.status),
    amount: payment.value.toFixed(2),
    currency: 'BRL',
    dueAt: parseDate(payment.dueDate),
    // `confirmedDate` primeiro: `paymentDate` é a data do crédito e, no cartão,
    // só é preenchida ~32 dias depois, no `PAYMENT_RECEIVED`.
    paidAt: parseDate(payment.confirmedDate ?? payment.clientPaymentDate ?? payment.paymentDate),
    providerSubscriptionId: payment.subscription ?? null,
    providerCustomerId: payment.customer ?? null,
    providerCheckoutId: payment.checkoutSession ?? null,
  };
}
