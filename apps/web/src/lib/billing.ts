import { apiClient } from './api-client';

export type BillingInterval = 'monthly' | 'annual';

export type SubscriptionStatus =
  | 'pending'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'expired';

export interface Plan {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  price: string; // Decimal serializado como string pela API
  currency: string;
  interval: BillingInterval;
  isActive: boolean;
  maxMembers: number;
  features?: Record<string, unknown> | null;
}

export interface SubscriptionAccess {
  allowed: boolean;
  reason: string;
  status: SubscriptionStatus | null;
  subscriptionId: string | null;
}

export interface SubscriptionState {
  status: SubscriptionStatus | null;
  plan: Plan | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  graceUntil: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  access: SubscriptionAccess;
}

export const getPlans = () => apiClient.get<Plan[]>('/billing/plans');

export const getSubscription = () => apiClient.get<SubscriptionState>('/billing/subscription');

export const createCheckout = (planId: string) =>
  apiClient.post<{ checkoutUrl: string }>('/billing/checkout', { planId });

export const createPaymentMethodSession = () =>
  apiClient.post<{ url: string }>('/billing/payment-method', {});

export const cancelSubscription = () => apiClient.post<SubscriptionState>('/billing/cancel', {});

// Planos que liberam a área Empresa. Inclui os códigos legados mantidos vivos
// no seed (retiredPlanCodes) para não tirar o acesso de quem já assinava
// antes da introdução dos planos Individual/Duo/Business.
const BUSINESS_PLAN_CODES = new Set([
  'vellun-business-mensal',
  'vellun-business-anual',
  'vellun-mensal',
  'vellun-anual',
  'vellun-family-mensal',
  'vellun-family-anual',
]);

/** Deriva o acesso à área Empresa pelo `code` (imutável), não pelo `name` (texto de marketing). */
export function hasBusinessArea(plan?: { code?: string | null } | null): boolean {
  return !!plan?.code && BUSINESS_PLAN_CODES.has(plan.code);
}

/** Formata valor monetário em R$ (pt-BR). */
export function formatBRL(value: string | number): string {
  return Number(value).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function intervalLabel(interval: BillingInterval): string {
  return interval === 'annual' ? 'Anual' : 'Mensal';
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('pt-BR');
}

const STATUS_META: Record<
  SubscriptionStatus,
  { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }
> = {
  active: { label: 'Ativa', variant: 'success' },
  trialing: { label: 'Em teste', variant: 'success' },
  past_due: { label: 'Pagamento pendente', variant: 'warning' },
  pending: { label: 'Aguardando pagamento', variant: 'secondary' },
  unpaid: { label: 'Não paga', variant: 'destructive' },
  canceled: { label: 'Cancelada', variant: 'secondary' },
  expired: { label: 'Expirada', variant: 'destructive' },
};

export function statusMeta(status: SubscriptionStatus | null) {
  if (!status) return { label: 'Sem assinatura', variant: 'secondary' as const };
  return STATUS_META[status];
}
