import { Inject, Injectable, Logger } from '@nestjs/common';
import { Subscription, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  NormalizedWebhookEvent,
  PAYMENT_PROVIDER,
  PaymentProvider,
} from '../providers/payment-provider.interface';
import { ChargeSyncService, SubscriptionWithPlan } from '../services/charge-sync.service';
import { SubscriptionStateService } from '../services/subscription-state.service';
import { SubscriptionService } from '../services/subscription.service';
import { WebhookEventService } from './webhook-event.service';

/**
 * Desfecho de uma tentativa, para o cron registrar e para os testes afirmarem.
 *
 * `unrecorded` é a tentativa que falhou **e** cuja falha não pôde ser gravada
 * (banco fora). A linha fica em `processing`, e a varredura a devolve à fila
 * depois de 15 min, com a contagem de tentativas intacta. Chamar isso de
 * `retry_scheduled` seria afirmar um agendamento que não existe.
 */
export type AttemptOutcome =
  | 'processed'
  | 'skipped'
  | 'retry_scheduled'
  | 'exhausted'
  | 'unrecorded';

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
    private readonly charges: ChargeSyncService,
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
      // processo, depois de um deploy. Quem lê a contagem é o próprio
      // `markFailed`, na mesma transação em que grava — sem palpite de fallback.
      let registrado: Awaited<ReturnType<WebhookEventService['markFailed']>>;
      try {
        registrado = await this.events.markFailed(eventId, message);
      } catch (erroAoRegistrar) {
        this.logger.error(
          `Webhook ${eventId} falhou e a falha não pôde ser registrada; a varredura de ` +
            `presos o devolve à fila. Falha original: ${message}`,
          erroAoRegistrar instanceof Error ? erroAoRegistrar.stack : undefined,
        );
        return 'unrecorded';
      }

      if (registrado.status === 'exhausted') {
        this.logger.error(
          `Webhook ${eventId} esgotado após ${registrado.attempts} tentativa(s): ${message}`,
        );
        return 'exhausted';
      }

      this.logger.warn(
        `Webhook ${eventId}: tentativa ${registrado.attempts} falhou, reagendada para ` +
          `${registrado.nextRetryAt?.toISOString() ?? 'data desconhecida'}: ${message}`,
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
    if (event.intent === 'subscription_canceled') return this.applyCanceled(event);
    return this.applyCharge(event);
  }

  /**
   * Evento de cobrança: o payload só diz **qual** cobrança mudou.
   *
   * O estado dela, e a quem pertence, vêm do PSP. O webhook é autenticado por
   * um token estático, então confiar no status do payload seria deixar quem
   * tivesse o token conceder acesso a si mesmo. E a ordem dos eventos deixa de
   * importar: um `PAYMENT_OVERDUE` atrasado consulta a cobrança e a encontra paga.
   */
  private async applyCharge(event: NormalizedWebhookEvent): Promise<string | null> {
    if (!event.payment) {
      this.logger.warn(`Webhook de cobrança sem cobrança no payload (intent=${event.intent})`);
      return null;
    }

    const charge = await this.provider.getPayment(event.payment.providerPaymentId);
    const subscription = await this.locate(charge);
    if (!subscription) {
      this.logger.warn(`Webhook sem assinatura local correlacionável (intent=${event.intent})`);
      return null;
    }

    await this.charges.sync(subscription, charge, { source: 'webhook', onlyOnChange: true });
    return subscription.id;
  }

  private async applyCanceled(event: NormalizedWebhookEvent): Promise<string | null> {
    const subscription = await this.locate(event);
    if (!subscription) {
      this.logger.warn(`Webhook sem assinatura local correlacionável (intent=${event.intent})`);
      return null;
    }

    await this.handleCanceled(subscription);
    return subscription.id;
  }

  private async locate(ref: {
    providerSubscriptionId: string | null;
    providerCustomerId: string | null;
  }): Promise<SubscriptionWithPlan | null> {
    // Cobrança avulsa (sem assinatura no PSP) não é de nenhuma assinatura
    // nossa, mesmo sendo de um cliente nosso.
    if (!ref.providerSubscriptionId) return null;

    const bySub = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: ref.providerSubscriptionId },
      include: { plan: true },
    });
    if (bySub || !ref.providerCustomerId) return bySub;

    // Assinatura do PSP ainda desconhecida aqui: só pode ser a de uma linha que
    // espera o vínculo (a primeira cobrança de um checkout). Uma linha já
    // vinculada a OUTRA assinatura do PSP não serve — casar por cliente faria o
    // estorno de uma cobrança duplicada cancelar a assinatura válida.
    return this.prisma.subscription.findFirst({
      where: {
        providerCustomerId: ref.providerCustomerId,
        providerSubscriptionId: null,
        status: { notIn: [SubscriptionStatus.canceled, SubscriptionStatus.expired] },
      },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });
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
}
