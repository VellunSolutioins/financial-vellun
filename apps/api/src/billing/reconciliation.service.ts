import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SubscriptionStatus } from '@prisma/client';

import { lockSubscription } from '../common/db';
import { PrismaService } from '../prisma/prisma.service';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
  ProviderPayment,
} from './providers/payment-provider.interface';
import { ChargeSyncService, SubscriptionWithPlan } from './services/charge-sync.service';
import { SubscriptionStateService } from './services/subscription-state.service';
import { SubscriptionService } from './services/subscription.service';

type ReconcileOutcome = 'consistent' | 'corrected' | 'divergent' | 'error';

export interface ReconcileSummary {
  checked: number;
  corrected: number;
  divergent: number;
  errors: number;
  /** Tentativas de checkout que não foram pagas e foram expiradas. */
  expiredCheckouts: number;
}

/** Quantas assinaturas verificar por execução. */
const BATCH_SIZE = 200;

/**
 * Folga depois do vencimento do checkout antes de expirar a assinatura. O
 * pagamento feito no último minuto ainda precisa do webhook para chegar.
 */
const CHECKOUT_EXPIRY_MARGIN_MS = 30 * 60 * 1000;

/**
 * Assinatura `pending` de antes de o vencimento do checkout ser gravado: sem a
 * data, vale o tempo parada. Um dia é muito além dos 60 minutos do checkout.
 */
const LEGACY_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Segunda linha de defesa contra divergências banco↔PSP (doc seção 7). Consulta
 * periodicamente o estado real no Asaas e corrige o banco de forma auditável,
 * emitindo alerta operacional quando a divergência não é auto-corrigível.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private running = false;

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
    private readonly state: SubscriptionStateService,
    private readonly charges: ChargeSyncService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'billing-reconciliation' })
  async handleCron(): Promise<void> {
    if (this.running) {
      this.logger.warn('Reconciliação anterior ainda em execução; pulando ciclo.');
      return;
    }
    this.running = true;
    try {
      const summary = await this.reconcile();
      this.logger.log(
        `Reconciliação: ${summary.checked} verificadas, ${summary.corrected} corrigidas, ` +
          `${summary.divergent} divergências manuais, ${summary.errors} erros, ` +
          `${summary.expiredCheckouts} checkouts expirados.`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Reconcilia um lote de assinaturas com vínculo no PSP. */
  async reconcile(): Promise<ReconcileSummary> {
    const candidates = await this.prisma.subscription.findMany({
      where: {
        // Só as do PSP configurado: os ids de outro não significam nada para ele.
        provider: this.provider.name,
        providerSubscriptionId: { not: null },
        status: {
          in: [
            SubscriptionStatus.active,
            SubscriptionStatus.trialing,
            SubscriptionStatus.past_due,
            SubscriptionStatus.unpaid,
            SubscriptionStatus.pending,
          ],
        },
      },
      // Só o necessário para consultar o PSP: o estado local é relido depois,
      // assinatura por assinatura (ver `reconcileSubscription`).
      select: { id: true, providerSubscriptionId: true },
      // Rodízio: quem nunca foi olhada primeiro, depois a olhada há mais tempo.
      // Por `updatedAt` as consistentes nunca saíam do topo, e acima de
      // BATCH_SIZE assinaturas as demais não eram verificadas.
      orderBy: { lastReconciledAt: { sort: 'asc', nulls: 'first' } },
      take: BATCH_SIZE,
    });

    const summary: ReconcileSummary = {
      checked: candidates.length,
      corrected: 0,
      divergent: 0,
      errors: 0,
      expiredCheckouts: 0,
    };

    try {
      for (const candidate of candidates) {
        try {
          const outcome = await this.reconcileSubscription(candidate);
          if (outcome === 'corrected') summary.corrected++;
          else if (outcome === 'divergent') summary.divergent++;
          else if (outcome === 'error') summary.errors++;
        } catch (error) {
          summary.errors++;
          const message = error instanceof Error ? error.message : String(error);
          this.alert(`Falha ao reconciliar assinatura ${candidate.id}: ${message}`);
        }
      }
    } finally {
      await this.advanceCursor(candidates.map((candidate) => candidate.id));
    }

    summary.expiredCheckouts = await this.expireStaleCheckouts();
    return summary;
  }

  /**
   * Expira as tentativas de checkout que não foram pagas. O aviso de checkout
   * vencido do PSP faz isso na hora; aqui é a rede de segurança para quando
   * ele se perde. Sem isto a assinatura ficava `pending` para sempre, e a tela,
   * em "pagamento em processamento".
   *
   * Pagamento que chegue depois ainda ativa: `expired` aceita voltar a `active`.
   */
  private async expireStaleCheckouts(now: Date = new Date()): Promise<number> {
    try {
      // Sem filtro de PSP: expirar é só local, e as tentativas antigas sem PSP
      // nenhum (`provider` nulo) também precisam sair de `pending`.
      const where = {
        status: SubscriptionStatus.pending,
        providerSubscriptionId: null,
        OR: [
          { checkoutExpiresAt: { lt: new Date(now.getTime() - CHECKOUT_EXPIRY_MARGIN_MS) } },
          {
            checkoutExpiresAt: null,
            updatedAt: { lt: new Date(now.getTime() - LEGACY_PENDING_MAX_AGE_MS) },
          },
        ],
      };
      const stale = await this.prisma.subscription.findMany({
        where,
        select: { id: true },
        take: BATCH_SIZE,
      });

      let expired = 0;
      for (const { id } of stale) {
        // Com a linha travada, confere de novo se ela continua vencida: o
        // usuário pode ter aberto outro checkout nela depois da consulta.
        const done = await this.prisma.$transaction(async (tx) => {
          await lockSubscription(tx, id);
          const stillStale = await tx.subscription.count({ where: { id, ...where } });
          if (stillStale === 0) return false;
          return this.subscriptions.expireCheckout(
            id,
            'reconciliation',
            'checkout vencido sem pagamento',
            tx,
          );
        });
        if (done) expired++;
      }
      return expired;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.alert(`Falha ao expirar checkouts vencidos: ${message}`);
      return 0;
    }
  }

  /**
   * Avança o cursor do rodízio do lote inteiro, inclusive das que falharam: uma
   * assinatura que sempre dá erro não pode segurar o topo da fila.
   */
  private async advanceCursor(subscriptionIds: string[]): Promise<void> {
    if (subscriptionIds.length === 0) return;
    try {
      await this.prisma.subscription.updateMany({
        where: { id: { in: subscriptionIds } },
        data: { lastReconciledAt: new Date() },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Não foi possível avançar o cursor da reconciliação: ${message}`);
    }
  }

  /** Compara uma assinatura local com o estado real no PSP e corrige se preciso. */
  async reconcileSubscription(candidate: {
    id: string;
    providerSubscriptionId: string | null;
  }): Promise<ReconcileOutcome> {
    if (!candidate.providerSubscriptionId) return 'consistent';

    const remote = await this.provider.getSubscription(candidate.providerSubscriptionId);
    const terminal = this.terminalFromRemote(remote.status);
    // 'inactive' e demais estados ambíguos não são auto-corrigidos.
    if (!terminal && remote.status !== 'active') return 'consistent';

    const charges = terminal
      ? []
      : await this.provider.listSubscriptionPayments(candidate.providerSubscriptionId);

    // O estado local é lido DEPOIS das consultas ao PSP. O lote leva minutos,
    // e decidir com a linha carregada no início dele desfaria o que um webhook
    // tivesse aplicado nesse meio-tempo.
    const local = await this.prisma.subscription.findUnique({
      where: { id: candidate.id },
      include: { plan: true },
    });
    if (!local) return 'consistent';

    if (terminal) return this.reconcileTerminal(local, terminal, remote.status);

    // O usuário pediu o cancelamento e o PSP continua com a assinatura ativa:
    // a chamada falhou, ou o processo caiu antes dela. A intenção gravada manda.
    // As cobranças seguem sendo conferidas logo abaixo: enquanto o PSP recusar
    // o cancelamento, uma cobrança vencida ainda tem de rebaixar a assinatura.
    const cancelRedone = local.cancelAtPeriodEnd
      ? await this.redoCancellation(local.id, candidate.providerSubscriptionId)
      : false;

    // Assinatura `active` no PSP só quer dizer que ela continua gerando
    // cobranças — segue assim com cobrança vencida ou em chargeback. Quem diz
    // se o cliente está em dia são as cobranças.
    const charge = this.decidingCharge(charges);
    if (!charge) return cancelRedone ? 'corrected' : 'consistent';

    // Disputa que já terminou no PSP e ainda consta aberta aqui bloquearia o
    // webhook de reativar; acerta o registro antes de decidir.
    await this.charges.refreshResolvedChargebacks(local, charges);

    // O PSP gera a próxima cobrança com semanas de antecedência. Se não existe
    // nenhuma depois desta, a assinatura parou de cobrar: uma `active` cujo
    // período pago acabou não seria rebaixada por evento nenhum.
    const chargeDueAt = charge.dueAt;
    const isLastGenerated = !charges.some(
      (other) =>
        other.status !== 'canceled' && other.dueAt && chargeDueAt && other.dueAt > chargeDueAt,
    );

    const outcome = await this.charges.sync(local, charge, 'reconciliation', {
      isLastGenerated,
      billingInterval: remote.interval ?? null,
    });
    if (outcome === 'applied') {
      this.alert(
        `Assinatura ${local.id} corrigida por reconciliação a partir da cobrança ` +
          `${charge.id} (${charge.status}); estava ${local.status}.`,
      );
      return 'corrected';
    }
    if (outcome === 'held') {
      this.alert(
        `Assinatura ${local.id} está ${local.status} com a cobrança ${charge.id} estornada. ` +
          'A reconciliação não cancela sozinha; avaliar o cancelamento manualmente.',
      );
      return 'divergent';
    }
    return cancelRedone ? 'corrected' : 'consistent';
  }

  /** Refaz no PSP o cancelamento que o usuário pediu. Falhar aqui não impede o resto. */
  private async redoCancellation(subscriptionId: string, providerSubscriptionId: string) {
    try {
      await this.provider.cancelSubscription({ providerSubscriptionId });
      this.alert(`Assinatura ${subscriptionId}: cancelamento pedido pelo usuário refeito no PSP.`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.alert(
        `Assinatura ${subscriptionId}: o PSP recusou de novo o cancelamento pedido (${message}).`,
      );
      return false;
    }
  }

  /** Assinatura encerrada no PSP: o estado local acompanha. */
  private async reconcileTerminal(
    local: SubscriptionWithPlan,
    target: SubscriptionStatus,
    remoteStatus: string,
  ): Promise<ReconcileOutcome> {
    if (local.status === target) return 'consistent';

    // Cancelamento agendado ainda dentro do período pago: o PSP já reporta a
    // assinatura como cancelada/deletada, mas o acesso é mantido até
    // `currentPeriodEnd`. A correção para `canceled` ocorre no ciclo seguinte
    // ao fim do período, quando o cancelamento deixa de estar adiado.
    if (target === SubscriptionStatus.canceled && this.state.isCancellationDeferred(local)) {
      return 'consistent';
    }

    if (!this.state.canTransition(local.status, target)) {
      this.alert(
        `Divergência não auto-corrigível na assinatura ${local.id}: ` +
          `local=${local.status} remoto=${remoteStatus}`,
      );
      return 'divergent';
    }

    await this.subscriptions.transitionTo(local.id, target, {
      actor: 'reconciliation',
      reason: `divergência banco↔PSP: local=${local.status} remoto=${remoteStatus}`,
      data: target === SubscriptionStatus.canceled ? { canceledAt: new Date() } : {},
    });
    this.alert(`Assinatura ${local.id} corrigida por reconciliação: ${local.status} → ${target}`);
    return 'corrected';
  }

  private terminalFromRemote(remoteStatus: string): SubscriptionStatus | null {
    if (remoteStatus === 'canceled') return SubscriptionStatus.canceled;
    if (remoteStatus === 'expired') return SubscriptionStatus.expired;
    return null;
  }

  /**
   * A cobrança que decide o estado da assinatura.
   *
   * Havendo alguma em disputa, é ela, por mais antiga que seja: a contestação
   * revoga o acesso enquanto durar. Senão, a mais recente cujo vencimento já
   * chegou — o PSP gera cobranças com antecedência, então as do topo da lista
   * costumam ser futuras e ainda `pending`, e não dizem nada sobre o cliente
   * estar em dia.
   */
  private decidingCharge(
    charges: ProviderPayment[],
    now: Date = new Date(),
  ): ProviderPayment | null {
    const newestFirst = charges
      .filter((charge) => charge.status !== 'canceled' && charge.dueAt && charge.dueAt <= now)
      .sort((a, b) => b.dueAt!.getTime() - a.dueAt!.getTime());
    return newestFirst.find((charge) => charge.status === 'chargeback') ?? newestFirst[0] ?? null;
  }

  private alert(message: string): void {
    // Alerta operacional. Em produção, encaminhar para o canal de observabilidade.
    this.logger.warn(`[reconciliação] ${message}`);
  }
}
