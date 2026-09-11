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

/** Desfecho de uma tentativa, para o cron registrar e para os testes afirmarem. */
export type AttemptOutcome = 'processed' | 'skipped' | 'retry_scheduled' | 'exhausted';

/**
 * Processa eventos de webhook de forma assíncrona e idempotente. Mapeia a
 * intenção normalizada para transições da máquina de estados e confirma eventos
 * críticos com o PSP.
 *
 * **O retry não vive mais neste processo.** Ele era uma cadeia de `setTimeout`
 * (5 tentativas, ~7,5 s no total), e um deploy dentro dessa janela perdia o
 * evento — silenciosamente, num caminho que move dinheiro. Agora cada tentativa
 * agenda a próxima em `next_retry_at`, e {@link WebhookRetryService} varre o que
 * venceu. A durabilidade passa a ser do Postgres, não da memória do processo.
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

  /**
   * Agenda a primeira tentativa (responde rápido ao PSP).
   *
   * Continua imediata: a maioria dos eventos passa de primeira, e esperar o
   * próximo ciclo do cron atrasaria a liberação de acesso de um cliente que
   * acabou de pagar. O que mudou é o que acontece **quando falha**.
   */
  enqueue(eventId: string): void {
    setImmediate(() => void this.attempt(eventId));
  }

  /**
   * Uma tentativa completa: reivindica, processa e, em falha, agenda a próxima.
   *
   * Usada tanto pelo webhook quanto pelo cron de varredura — um caminho só, para
   * que o comportamento sob falha não dependa de quem chamou.
   */
  async attempt(eventId: string): Promise<AttemptOutcome> {
    try {
      const processado = await this.process(eventId);
      return processado ? 'processed' : 'skipped';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // As tentativas são contadas no banco pelo `markProcessing`, não numa
      // variável local: é o que permite a próxima tentativa acontecer em outro
      // processo, depois de um deploy.
      const atual = await this.prisma.paymentWebhookEvent
        .findUnique({ where: { id: eventId }, select: { attempts: true } })
        .catch(() => null);

      const atualizado = await this.events
        .markFailed(eventId, message, atual?.attempts ?? 1)
        .catch(() => null);

      if (atualizado?.status === 'exhausted') {
        this.logger.error(
          `Webhook ${eventId} esgotado após ${atual?.attempts ?? '?'} tentativa(s): ${message}`,
        );
        return 'exhausted';
      }

      this.logger.warn(
        `Webhook ${eventId}: tentativa ${atual?.attempts ?? '?'} falhou, reagendada para ` +
          `${atualizado?.nextRetryAt?.toISOString() ?? 'data desconhecida'}: ${message}`,
      );
      return 'retry_scheduled';
    }
  }

  /**
   * Processa um evento já persistido. Idempotente: ignora eventos já
   * processados e os que outro processo reivindicou.
   *
   * Devolve `false` quando não havia o que fazer — o chamador usa isso para
   * distinguir "processei" de "outro já estava cuidando".
   */
  async process(eventId: string): Promise<boolean> {
    const event = await this.prisma.paymentWebhookEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    if (event.status === 'processed') return false;

    if (!(await this.events.markProcessing(eventId))) {
      this.logger.log(`Webhook ${eventId} já reivindicado por outro processo; ignorando`);
      return false;
    }

    const normalized = this.provider.normalizeWebhookEvent({
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      payload: event.sanitizedPayload,
    });

    const subscriptionId = await this.apply(normalized);
    if (subscriptionId) await this.events.linkSubscription(eventId, subscriptionId);

    await this.events.markProcessed(eventId);
    return true;
  }

  /** Aplica a intenção. Devolve a assinatura correlacionada, quando houver. */
  private async apply(event: NormalizedWebhookEvent): Promise<string | null> {
    if (event.intent === 'ignore') return null;

    const subscription = await this.locate(event);
    if (!subscription) {
      this.logger.warn(`Webhook sem assinatura local correlacionável (intent=${event.intent})`);
      return null;
    }

    await this.dispatch(subscription, event);
    return subscription.id;
  }

  private async dispatch(
    subscription: SubscriptionWithPlan,
    event: NormalizedWebhookEvent,
  ): Promise<void> {
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
    // Cancelamento agendado para o fim do período pago: o PSP exclui a assinatura
    // imediatamente, mas o acesso deve continuar até `currentPeriodEnd`. A
    // reconciliação efetiva o `canceled` quando o período expira.
    if (this.state.isCancellationDeferred(sub)) {
      this.logger.log(
        `Assinatura ${sub.id}: cancelamento adiado até o fim do período pago ` +
          `(${sub.currentPeriodEnd?.toISOString() ?? 'sem data'}); acesso preservado.`,
      );
      return;
    }

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
