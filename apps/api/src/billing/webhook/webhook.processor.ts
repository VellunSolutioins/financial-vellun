import { Inject, Injectable, Logger } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';

import { Db, FINANCIAL_TX_OPTIONS, lockSubscription } from '../../common/db';
import { PrismaService } from '../../prisma/prisma.service';
import { UncorrelatedPaymentEventError } from '../billing.errors';
import {
  NormalizedWebhookEvent,
  PAYMENT_PROVIDER,
  PaymentProvider,
} from '../providers/payment-provider.interface';
import {
  ChargeSyncResult,
  ChargeSyncService,
  SubscriptionWithPlan,
} from '../services/charge-sync.service';
import { SubscriptionStateService } from '../services/subscription-state.service';
import { SubscriptionService } from '../services/subscription.service';
import { WebhookEventService } from './webhook-event.service';

/**
 * Desfecho de uma tentativa, para o cron registrar e para os testes afirmarem.
 *
 * `unrecorded` é a tentativa que falhou **e** cuja falha não pôde ser gravada
 * (banco fora). A linha fica onde estava — em `processing`, ou em `received`
 * se a falha veio antes da reivindicação — e a varredura a devolve à fila, com
 * a contagem de tentativas intacta. Chamar isso de `retry_scheduled` seria
 * afirmar um agendamento que não existe.
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
          `Webhook ${eventId} falhou e a falha não pôde ser registrada; a varredura ` +
            `o devolve à fila. Falha original: ${message}`,
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

    // Evento de outro PSP (gravado quando ele era o configurado): este adapter
    // não sabe ler o payload, nem consultar as cobranças dele. Pode ser uma
    // confirmação de pagamento, então fica no painel para tratar à mão.
    if (event.provider !== this.provider.name) {
      const reason =
        `evento do PSP ${event.provider}, mas o configurado é ${this.provider.name}; ` +
        'precisa ser tratado à mão';
      this.logger.error(`Webhook ${eventId}: ${reason}`);
      await this.events.markUnprocessable(eventId, reason);
      return true;
    }

    const normalized = this.provider.normalizeWebhookEvent({
      provider: event.provider,
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      payload: event.sanitizedPayload,
    });

    await this.apply(eventId, normalized, event.receivedAt);

    // Só aqui, depois do commit: contar antes faria a métrica divergir do banco
    // quando a transação falha.
    this.events.observeProcessed();
    return true;
  }

  /** Aplica a intenção e fecha o evento no mesmo commit dos efeitos que ele causou. */
  private async apply(
    eventId: string,
    event: NormalizedWebhookEvent,
    receivedAt: Date,
  ): Promise<void> {
    switch (event.intent) {
      case 'ignore':
        return this.close(eventId, null);
      case 'subscription_canceled':
        return this.applyCanceled(eventId, event);
      case 'subscription_created':
        return this.applySubscriptionCreated(eventId, event);
      case 'checkout_expired':
        return this.applyCheckoutExpired(eventId, event);
      default:
        return this.applyCharge(eventId, event, receivedAt);
    }
  }

  /**
   * Uma transação por evento: os efeitos na assinatura (transição, auditoria,
   * cobrança) e o `processed` do evento entram juntos ou não entram.
   *
   * Em commits separados, uma falha no meio deixava estado parcial e o retry
   * reaplicava tudo por cima — ou, pior, o evento virava `processed` sem o
   * efeito ter sido gravado.
   */
  private async close(
    eventId: string,
    subscriptionId: string | null,
    effects?: (tx: Db) => Promise<unknown>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (effects) await effects(tx);
      await this.events.markProcessed(eventId, subscriptionId, tx);
    }, FINANCIAL_TX_OPTIONS);
  }

  /**
   * Evento de cobrança: o payload só diz **qual** cobrança mudou.
   *
   * O estado dela, e a quem pertence, vêm do PSP. O webhook é autenticado por
   * um token estático, então confiar no status do payload seria deixar quem
   * tivesse o token conceder acesso a si mesmo. E a ordem dos eventos deixa de
   * importar: um `PAYMENT_OVERDUE` atrasado consulta a cobrança e a encontra paga.
   *
   * A consulta ao PSP vem antes da transação, e o que a decisão exigir dele
   * (cancelar, num estorno), depois do commit. Dentro dela, só banco.
   */
  private async applyCharge(
    eventId: string,
    event: NormalizedWebhookEvent,
    receivedAt: Date,
  ): Promise<void> {
    if (!event.payment) {
      this.logger.warn(`Webhook de cobrança sem cobrança no payload (intent=${event.intent})`);
      return this.close(eventId, null);
    }

    const charge = await this.provider.getPayment(event.payment.providerPaymentId);

    // Cobrança avulsa (sem assinatura nem checkout no PSP) não é de nenhuma
    // assinatura nossa, mesmo sendo de um cliente nosso.
    if (!charge.providerSubscriptionId && !charge.providerCheckoutId) {
      this.logger.log(`Cobrança avulsa ${charge.id} ignorada (intent=${event.intent})`);
      return this.close(eventId, null);
    }

    const paid = charge.status === 'paid';
    const subscription = await this.locate(charge, { byCustomer: paid });
    if (!subscription) {
      // Pagou e não há a quem dar acesso: tem de aparecer. As demais (vencida,
      // estornada...) de uma assinatura que não conhecemos não mudam nada aqui;
      // fazê-las falhar encheria o painel de eventos que nunca vão correlacionar.
      // Só o aviso de pagamento: um aviso de alteração de uma cobrança paga e
      // desconhecida (descrição, vencimento) não é o pagamento sem dono.
      if (paid && event.intent === 'payment_succeeded') {
        throw new UncorrelatedPaymentEventError(charge.id, charge.providerSubscriptionId);
      }
      this.logger.warn(
        `Cobrança ${charge.id} (${charge.status}) sem assinatura local correlacionável; ignorada`,
      );
      return this.close(eventId, null);
    }

    // Primeira ativação: o ciclo da assinatura do PSP diz que plano foi pago
    // quando o valor não bate com o da assinatura local. Consultado aqui, fora
    // da transação.
    const firstActivation = paid && subscription.currentPeriodStart === null;
    const billingInterval =
      firstActivation && charge.providerSubscriptionId
        ? ((await this.provider.getSubscription(charge.providerSubscriptionId)).interval ?? null)
        : null;

    let result!: ChargeSyncResult;
    await this.prisma.$transaction(async (tx) => {
      result = await this.charges.applyInTransaction(tx, subscription.id, charge, 'webhook', {
        billingInterval,
        // Hora em que o aviso chegou: retry e reprocessamento não a deslocam.
        refusal: event.paymentFailureReason
          ? { reason: event.paymentFailureReason, at: receivedAt }
          : null,
      });
      // Com cancelamento pendente no PSP, o evento fica aberto: se o PSP
      // falhar, é o retry dele que tenta de novo.
      if (result.cancelAtGateway.length === 0) {
        await this.events.markProcessed(eventId, subscription.id, tx);
      }
    }, FINANCIAL_TX_OPTIONS);

    if (result.cancelAtGateway.length > 0) {
      await this.charges.settle(result);
      await this.close(eventId, subscription.id, (tx) =>
        this.charges.completeSupersession(tx, result),
      );
    }
  }

  private async applyCanceled(eventId: string, event: NormalizedWebhookEvent): Promise<void> {
    const subscription = await this.locate(event, { byCustomer: false });
    if (!subscription) {
      // Assinatura do PSP que não é nossa (ou que nunca chegou a ser paga):
      // não há o que cancelar aqui.
      this.logger.warn(`Webhook sem assinatura local correlacionável (intent=${event.intent})`);
      return this.close(eventId, null);
    }

    await this.close(eventId, subscription.id, (tx) =>
      this.cancelInTransaction(tx, subscription.id),
    );
  }

  /**
   * Checkout vencido ou cancelado pelo pagador: a tentativa `pending` que ele
   * abriu é expirada, para a tela voltar a oferecer os planos. Se a assinatura
   * já saiu de `pending` (o pagamento chegou antes), o evento não muda nada.
   */
  private async applyCheckoutExpired(eventId: string, event: NormalizedWebhookEvent) {
    const subscription = event.providerCheckoutId
      ? await this.prisma.subscription.findFirst({
          where: { provider: this.provider.name, providerCheckoutId: event.providerCheckoutId },
        })
      : null;
    if (!subscription) return this.close(eventId, null);

    await this.close(eventId, subscription.id, async (tx) => {
      await lockSubscription(tx, subscription.id);
      // Sob a trava, a linha ainda tem de ser deste checkout: o usuário pode ter
      // aberto outro nela enquanto o aviso esperava, e aí quem expiraria seria
      // a tentativa nova.
      const current = await tx.subscription.findUnique({ where: { id: subscription.id } });
      if (current?.providerCheckoutId !== event.providerCheckoutId) return;
      await this.subscriptions.expireCheckout(
        subscription.id,
        'webhook:checkout_expired',
        'checkout encerrado no PSP sem pagamento',
        tx,
      );
    });
  }

  /**
   * Assinatura criada no PSP: grava o vínculo na linha do checkout que a
   * originou. **Não concede acesso** — isso é da cobrança paga. Serve para a
   * reconciliação já enxergar a assinatura se o aviso de pagamento se perder.
   *
   * O evento só diz **qual** assinatura nasceu; de que checkout e de que
   * cliente ela é, quem diz é o PSP. A reconciliação concede acesso pelas
   * cobranças da assinatura vinculada, então aceitar o vínculo do payload seria
   * deixar quem tivesse o token do webhook ligar a assinatura paga de outra
   * pessoa a uma linha `pending` sua.
   */
  private async applySubscriptionCreated(eventId: string, event: NormalizedWebhookEvent) {
    if (!event.providerSubscriptionId) return this.close(eventId, null);

    const remote = await this.provider.getSubscription(event.providerSubscriptionId);
    const subscription = remote.providerCheckoutId
      ? await this.prisma.subscription.findFirst({
          where: { provider: this.provider.name, providerCheckoutId: remote.providerCheckoutId },
        })
      : null;
    if (!subscription) return this.close(eventId, null);

    const sameCustomer =
      !subscription.providerCustomerId ||
      subscription.providerCustomerId === remote.providerCustomerId;
    if (!sameCustomer) {
      this.logger.warn(
        `Assinatura ${remote.id} do PSP é de outro cliente que o da assinatura ` +
          `${subscription.id}; vínculo recusado.`,
      );
      return this.close(eventId, null);
    }

    await this.close(eventId, subscription.id, async (tx) => {
      // Só preenche o que está vazio: reentrega, ou a cobrança paga chegando
      // antes, já terão gravado o vínculo.
      await tx.subscription.updateMany({
        where: { id: subscription.id, providerSubscriptionId: null },
        data: { providerSubscriptionId: remote.id },
      });
    });
  }

  /**
   * Acha a assinatura local: pela assinatura do PSP e, se ela ainda não é
   * conhecida aqui, pelo checkout em que foi contratada.
   *
   * `byCustomer` liga o último recurso: casar pelo cliente com uma linha que
   * espera o vínculo. Existe para as assinaturas abertas antes de o checkout
   * ser gravado, e só serve para a primeira cobrança **paga** — é ela que
   * apresenta a assinatura nova. Aceitá-lo para qualquer evento deixaria uma
   * cobrança vencida, ou o cancelamento, de uma assinatura antiga e
   * desconhecida do mesmo cliente tomar a linha do checkout em andamento.
   */
  private async locate(
    ref: {
      providerSubscriptionId: string | null;
      providerCheckoutId: string | null;
      providerCustomerId: string | null;
    },
    options: { byCustomer: boolean },
  ): Promise<SubscriptionWithPlan | null> {
    if (ref.providerSubscriptionId) {
      const bySub = await this.prisma.subscription.findFirst({
        where: { provider: this.provider.name, providerSubscriptionId: ref.providerSubscriptionId },
        include: { plan: true },
      });
      if (bySub) return bySub;
    }
    if (ref.providerCheckoutId) {
      // Só linha ainda sem assinatura do PSP: o checkout apresenta UMA
      // assinatura, e ela já teria sido achada acima se fosse a desta linha.
      const byCheckout = await this.prisma.subscription.findFirst({
        where: {
          provider: this.provider.name,
          providerCheckoutId: ref.providerCheckoutId,
          providerSubscriptionId: null,
        },
        include: { plan: true },
      });
      if (byCheckout) return byCheckout;
    }
    if (!options.byCustomer || !ref.providerCustomerId) return null;

    // Uma linha já vinculada a OUTRA assinatura do PSP não serve — casar por
    // cliente faria a cobrança de uma assinatura duplicada mexer na válida.
    return this.prisma.subscription.findFirst({
      where: {
        provider: this.provider.name,
        providerCustomerId: ref.providerCustomerId,
        providerSubscriptionId: null,
        // `expired` entra: é a tentativa cujo checkout venceu ou foi trocado, e
        // o pagamento dele ainda pode chegar. Linha sem assinatura do PSP
        // nunca foi paga, então não há cancelamento de verdade a respeitar.
        status: { not: SubscriptionStatus.canceled },
      },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });
  }

  /** Cancela com a assinatura travada, decidindo sobre o estado atual dela. */
  private async cancelInTransaction(tx: Db, subscriptionId: string): Promise<void> {
    await lockSubscription(tx, subscriptionId);
    const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });

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

    // Transição inválida (reentrega, evento fora de ordem) é ignorada.
    if (!this.state.canTransition(sub.status, SubscriptionStatus.canceled)) {
      this.logger.warn(
        `Transição ignorada (${sub.status} → ${SubscriptionStatus.canceled}) ` +
          `para assinatura ${sub.id}`,
      );
      return;
    }

    await this.subscriptions.transitionTo(
      sub.id,
      SubscriptionStatus.canceled,
      { actor: 'webhook:subscription_canceled', data: { canceledAt: new Date() } },
      tx,
    );
  }
}
