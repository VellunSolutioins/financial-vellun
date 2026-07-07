import { z } from 'zod';

import {
  BillingInterval,
  PaymentMethodType,
  PaymentStatus,
  SubscriptionStatus,
} from '../enums';

export const PlanSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  price: z.number(),
  currency: z.string().length(3).default('BRL'),
  interval: z.enum([BillingInterval.MONTHLY, BillingInterval.ANNUAL]),
  is_active: z.boolean(),
  features: z.unknown().nullable().optional(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export const SubscriptionSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  plan_id: z.string().uuid(),
  provider_customer_id: z.string().nullable().optional(),
  provider_subscription_id: z.string().nullable().optional(),
  status: z.enum([
    SubscriptionStatus.PENDING,
    SubscriptionStatus.TRIALING,
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.PAST_DUE,
    SubscriptionStatus.CANCELED,
    SubscriptionStatus.UNPAID,
    SubscriptionStatus.EXPIRED,
  ]),
  current_period_start: z.coerce.date().nullable().optional(),
  current_period_end: z.coerce.date().nullable().optional(),
  trial_ends_at: z.coerce.date().nullable().optional(),
  grace_until: z.coerce.date().nullable().optional(),
  cancel_at_period_end: z.boolean(),
  canceled_at: z.coerce.date().nullable().optional(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export const PaymentSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  subscription_id: z.string().uuid().nullable().optional(),
  provider_payment_id: z.string().nullable().optional(),
  amount: z.number(),
  currency: z.string().length(3).default('BRL'),
  status: z.enum([
    PaymentStatus.PENDING,
    PaymentStatus.PROCESSING,
    PaymentStatus.PAID,
    PaymentStatus.FAILED,
    PaymentStatus.REFUNDED,
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.CHARGEBACK,
    PaymentStatus.CANCELED,
  ]),
  payment_method_type: z.enum([PaymentMethodType.CREDIT_CARD]),
  due_at: z.coerce.date().nullable().optional(),
  paid_at: z.coerce.date().nullable().optional(),
  failed_at: z.coerce.date().nullable().optional(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export const CreateCheckoutSchema = z.object({
  plan_id: z.string().uuid(),
});

export type Plan = z.infer<typeof PlanSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;
export type Payment = z.infer<typeof PaymentSchema>;
export type CreateCheckoutDto = z.infer<typeof CreateCheckoutSchema>;
