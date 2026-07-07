import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Subscription, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_PROVIDER, PaymentProvider } from './providers/payment-provider.interface';
import { SubscriptionAuditService } from './services/subscription-audit.service';
import { SubscriptionStateService } from './services/subscription-state.service';
import { SubscriptionService } from './services/subscription.service';

type ReconcileOutcome = 'consistent' | 'corrected' | 'divergent' | 'error';

export interface ReconcileSummary {
  checked: number;
  corrected: number;
  divergent: number;
  errors: number;
}

/** Quantas assinaturas verificar por execução. */
const BATCH_SIZE = 200;

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
    private readonly audit: SubscriptionAuditService,
    private readonly state: SubscriptionStateService,
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
          `${summary.divergent} divergências manuais, ${summary.errors} erros.`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Reconcilia um lote de assinaturas com vínculo no PSP. */
  async reconcile(): Promise<ReconcileSummary> {
    const candidates = await this.prisma.subscription.findMany({
      where: {
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
      orderBy: { updatedAt: 'asc' },
      take: BATCH_SIZE,
    });

    const summary: ReconcileSummary = {
      checked: candidates.length,
      corrected: 0,
      divergent: 0,
      errors: 0,
    };

    for (const local of candidates) {
      try {
        const outcome = await this.reconcileSubscription(local);
        if (outcome === 'corrected') summary.corrected++;
        else if (outcome === 'divergent') summary.divergent++;
        else if (outcome === 'error') summary.errors++;
      } catch (error) {
        summary.errors++;
        const message = error instanceof Error ? error.message : String(error);
        this.alert(`Falha ao reconciliar assinatura ${local.id}: ${message}`);
      }
    }

    return summary;
  }

  /** Compara uma assinatura local com o estado real no PSP e corrige se preciso. */
  async reconcileSubscription(local: Subscription): Promise<ReconcileOutcome> {
    if (!local.providerSubscriptionId) return 'consistent';

    const remote = await this.provider.getSubscription(local.providerSubscriptionId);
    const target = this.targetFromRemote(remote.status);
    if (!target) return 'consistent';

    if (local.status !== target) {
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
            `local=${local.status} remoto=${remote.status}`,
        );
        return 'divergent';
      }

      await this.subscriptions.transitionTo(local.id, target, {
        actor: 'reconciliation',
        reason: `divergência banco↔PSP: local=${local.status} remoto=${remote.status}`,
        data: this.correctionData(target, remote.currentPeriodEnd ?? null),
      });
      this.alert(`Assinatura ${local.id} corrigida por reconciliação: ${local.status} → ${target}`);
      return 'corrected';
    }

    // Mesmo status: detecta deriva no fim do período quando ativa.
    if (
      target === SubscriptionStatus.active &&
      this.periodDrifted(local, remote.currentPeriodEnd)
    ) {
      await this.prisma.subscription.update({
        where: { id: local.id },
        data: { currentPeriodEnd: remote.currentPeriodEnd },
      });
      await this.audit.record({
        subscriptionId: local.id,
        action: 'reconciliation:period_update',
        previousStatus: local.status,
        newStatus: local.status,
        actor: 'reconciliation',
        reason: 'ajuste de currentPeriodEnd',
      });
      this.alert(`Assinatura ${local.id}: currentPeriodEnd ajustado por reconciliação.`);
      return 'corrected';
    }

    return 'consistent';
  }

  private targetFromRemote(remoteStatus: string): SubscriptionStatus | null {
    switch (remoteStatus) {
      case 'active':
        return SubscriptionStatus.active;
      case 'canceled':
        return SubscriptionStatus.canceled;
      case 'expired':
        return SubscriptionStatus.expired;
      default:
        // 'inactive' e demais estados ambíguos não são auto-corrigidos.
        return null;
    }
  }

  private correctionData(target: SubscriptionStatus, currentPeriodEnd: Date | null) {
    if (target === SubscriptionStatus.active) {
      return currentPeriodEnd ? { currentPeriodEnd } : {};
    }
    if (target === SubscriptionStatus.canceled) {
      return { canceledAt: new Date() };
    }
    return {};
  }

  private periodDrifted(local: Subscription, remoteEnd: Date | null | undefined): boolean {
    if (!remoteEnd) return false;
    return local.currentPeriodEnd?.getTime() !== remoteEnd.getTime();
  }

  private alert(message: string): void {
    // Alerta operacional. Em produção, encaminhar para o canal de observabilidade.
    this.logger.warn(`[reconciliação] ${message}`);
  }
}
