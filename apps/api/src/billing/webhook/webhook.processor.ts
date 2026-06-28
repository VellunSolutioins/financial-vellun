import { Inject, Injectable, Logger } from '@nestjs/common';
import { Plan, PaymentStatus, Subscription, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  NormalizedWebhookEvent,
  PAYMENT_PROVIDER,
  PaymentProvider,
} from '../providers/payment-provider.interface';
import { PaymentService } from '../services/payment.service';
import { SubscriptionStateService } from '../services/subscription-state.service';
import { SubscriptionService } from '../services/subscription.service';
import { WebhookEventService } from './webhook-event.service';

type SubscriptionWithPlan = Subscription & { plan: Plan };

const MAX_ATTEMPTS = 5;

/**
 * Processa eventos de webhook de forma assíncrona e idempotente. Mapeia a
 * intenção normalizada para transições da máquina de estados, confirma eventos
 * críticos com o PSP e aplica retry com backoff; eventos que excedem o limite
 * permanecem em `failed` (dead-letter).
 */
@Injectable()
export class WebhookProcessor {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly prisma: PrismaService,
    private readonly events: WebhookEventService,
    private readonly subscriptions: SubscriptionService,
    private readonly state: SubscriptionStateService,
    private readonly payments: PaymentService,
  ) {}

  /** Agenda o processamento assíncrono (responde rápido ao PSP). */
  enqueue(eventId: string): void {
    setImmediate(() => void this.runWithRetry(eventId, 0));
  }

  private async runWithRetry(eventId: string, attempt: number): Promise<void> {
    try {
      await this.process(eventId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.events.markFailed(eventId, message).catch(() => undefined);

      const next = attempt + 1;
      if (next < MAX_ATTEMPTS) {
        const backoff = 2 ** attempt * 500;
        this.logger.warn(`Webhook ${eventId}: tentativa ${next} falhou, retentando em ${backoff}ms`);
        setTimeout(() => void this.runWithRetry(eventId, next), backoff);
      } else {
        this.logger.error(`Webhook ${eventId} enviado para DLQ após ${next} tentativas: ${message}`);
      }
    }
  }

  /** Processa um evento já persistido. Idempotente: ignora eventos já processados. */
  async process(eventId: string): Promise<void> {
    const event = await this.prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    if (event.status === 'processed') return;

    await this.events.markProcessing(eventId);

    const normalized = this.provider.normalizeWebhookEvent({
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      payload: event.sanitizedPayload,
    });

    await this.apply(normalized);
    await this.events.markProcessed(eventId);
  }

  private async apply(event: NormalizedWebhookEvent): Promise<void> {
    if (event.intent === 'ignore') return;

    const subscription = await this.locate(event);
    if (!subscription) {
      this.logger.warn(`Webhook sem assinatura local correlacionável (intent=${event.intent})`);
      return;
    }

    switch (event.intent) {
      case 'payment_succeeded':
        return this.handleSuccess(subscription, event);
      case 'payment_failed':
        return this.handleFailure(subscription, event);
      case 'payment_refunded':
        return this.recordPayment(subscription, event, PaymentStatus.refunded);
      case 'payment_chargeback':
        return this.handleChargeback(subscription, event);
      case 'subscription_canceled':
        return this.handleCanceled(subscription);
    }
  }

  private async locate(event: NormalizedWebhookEvent): Promise<SubscriptionWithPlan | null> {
    if (event.providerSubscriptionId) {
      const bySub = await this.prisma.subscription.findFirst({
        where: { providerSubscriptionId: event.providerSubscriptionId },
        include: { plan: true },
      });
      if (bySub) return bySub;
    }
    if (event.providerCustomerId) {
      return this.prisma.subscription.findFirst({
        where: {
          providerCustomerId: event.providerCustomerId,
          status: { notIn: [SubscriptionStatus.canceled, SubscriptionStatus.expired] },
        },
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      });
    }
    return null;
  }

  private async handleSuccess(sub: SubscriptionWithPlan, event: NormalizedWebhookEvent) {
    // Evento crítico: confirma o estado real no PSP antes de conceder acesso.
    let periodEnd: Date | null = null;
    if (event.providerSubscriptionId) {
      const remote = await this.provider.getSubscription(event.providerSubscriptionId);
      periodEnd = remote.currentPeriodEnd ?? null;
    }

    const start = new Date();
    const end = periodEnd ?? this.state.computePeriodEnd(start, sub.plan.interval);

    await this.tryTransition(sub, SubscriptionStatus.active, 'webhook:payment_succeeded', {
      providerSubscriptionId: event.providerSubscriptionId ?? sub.providerSubscriptionId,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      graceUntil: null,
    });

    await this.recordPayment(sub, event, PaymentStatus.paid);
  }

  private async handleFailure(sub: SubscriptionWithPlan, event: NormalizedWebhookEvent) {
    // Falha de renovação (já tinha acesso) → past_due com grace. Falha de
    // primeira cobrança (pending) → unpaid, sem conceder acesso.
    const accessStatuses: SubscriptionStatus[] = [
      SubscriptionStatus.active,
      SubscriptionStatus.trialing,
      SubscriptionStatus.past_due,
    ];
    const hadAccess = accessStatuses.includes(sub.status);

    if (hadAccess) {
      await this.tryTransition(sub, SubscriptionStatus.past_due, 'webhook:payment_failed', {
        graceUntil: this.state.computeGraceUntil(),
      });
    } else {
      await this.tryTransition(sub, SubscriptionStatus.unpaid, 'webhook:payment_failed', {});
    }

    await this.recordPayment(sub, event, PaymentStatus.failed);
  }

  private async handleChargeback(sub: SubscriptionWithPlan, event: NormalizedWebhookEvent) {
    await this.recordPayment(sub, event, PaymentStatus.chargeback);
    // Chargeback revoga o acesso: assinatura passa a `unpaid`.
    await this.tryTransition(sub, SubscriptionStatus.unpaid, 'webhook:payment_chargeback', {});
  }

  private async handleCanceled(sub: SubscriptionWithPlan) {
    await this.tryTransition(sub, SubscriptionStatus.canceled, 'webhook:subscription_canceled', {
      canceledAt: new Date(),
    });
  }

  /** Aplica a transição só quando válida — transições inválidas (replays/fora de ordem) são ignoradas. */
  private async tryTransition(
    sub: Subscription,
    to: SubscriptionStatus,
    actor: string,
    data: Parameters<SubscriptionService['transitionTo']>[2]['data'],
  ) {
    if (!this.state.canTransition(sub.status, to)) {
      this.logger.warn(`Transição ignorada (${sub.status} → ${to}) para assinatura ${sub.id}`);
      return;
    }
    await this.subscriptions.transitionTo(sub.id, to, { actor, data });
  }

  private async recordPayment(
    sub: Subscription,
    event: NormalizedWebhookEvent,
    status: PaymentStatus,
  ) {
    if (!event.payment) return;
    const now = new Date();
    await this.payments.upsertFromProvider({
      userId: sub.userId,
      subscriptionId: sub.id,
      providerPaymentId: event.payment.providerPaymentId,
      amount: event.payment.amount,
      currency: event.payment.currency,
      status,
      dueAt: event.payment.dueAt,
      paidAt: status === PaymentStatus.paid ? (event.payment.paidAt ?? now) : null,
      failedAt: status === PaymentStatus.failed ? now : null,
    });
  }
}
