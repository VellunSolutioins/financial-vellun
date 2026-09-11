import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OpsAuditResult, WebhookEventStatus } from '@prisma/client';

import { WebhookProcessor } from '../../billing/webhook/webhook.processor';
import { PrismaService } from '../../prisma/prisma.service';
import { OpsAuditService } from '../audit/ops-audit.service';
import { CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';

export type RecoverOutcome = 'processed' | 'retry_scheduled' | 'exhausted' | 'skipped';

export interface RecoverResult {
  id: string;
  outcome: RecoverOutcome;
  status: WebhookEventStatus;
  lastError: string | null;
}

/**
 * Recuperação de um evento de webhook esgotado.
 *
 * **Só `exhausted`.** Um evento `failed` ainda tem retry agendado e vai ser
 * tentado sozinho; deixar o operador agir sobre ele significaria reprocessar por
 * cima de um retry em andamento — que é exatamente o que a separação dos dois
 * estados existe para impedir.
 *
 * **Mudar status no banco não é reprocessar.** A recuperação devolve o evento à
 * fila e roda uma tentativa de verdade, pelo mesmo caminho de sempre. O efeito
 * externo duplicado é contido por onde já era: `process()` sai cedo se o evento
 * está `processed`, a identidade é o `providerEventId` (único), e `handleSuccess`
 * confirma o estado no PSP antes de conceder acesso.
 */
@Injectable()
export class OpsPaymentsActionsService {
  private readonly logger = new Logger(OpsPaymentsActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OpsAuditService,
    private readonly processor: WebhookProcessor,
  ) {}

  async recover(id: string, reason: string, operator: CurrentOpsOperator): Promise<RecoverResult> {
    const antes = await this.prisma.paymentWebhookEvent.findUnique({
      where: { id },
      select: { status: true, attempts: true, lastError: true },
    });
    if (!antes) throw new NotFoundException('Evento de webhook não encontrado.');

    const operationId = this.audit.newOperationId();

    // Reivindicar e auditar juntos: uma queda entre os dois passos deixaria o
    // evento devolvido à fila sem registro de quem mandou.
    const reivindicado = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.paymentWebhookEvent.updateMany({
        where: { id, status: WebhookEventStatus.exhausted },
        data: { status: WebhookEventStatus.failed, nextRetryAt: new Date() },
      });
      if (count === 0) return false;

      await this.audit.record(
        {
          operatorId: operator.id,
          action: OPS_AUDIT_ACTIONS.paymentEventRecovered,
          targetType: OPS_AUDIT_TARGETS.paymentWebhookEvent,
          targetId: id,
          reason,
          result: OpsAuditResult.success,
          operationId,
          beforeState: { status: antes.status, attempts: antes.attempts },
          afterState: { status: WebhookEventStatus.failed },
        },
        tx,
      );
      return true;
    });

    if (!reivindicado) {
      return {
        id,
        outcome: 'skipped',
        status: antes.status,
        lastError: antes.lastError,
      };
    }

    // Uma tentativa, agora. Se falhar de novo, `markFailed` esgota na hora —
    // porque `attempts` não é zerado: a recuperação dá uma tentativa a mais,
    // não um orçamento novo. Quem corrigiu a causa precisa de uma; quem não
    // corrigiu não deve queimar cinco contra uma dependência ainda quebrada.
    const desfecho = await this.processor.attempt(id);

    const depois = await this.prisma.paymentWebhookEvent.findUniqueOrThrow({
      where: { id },
      select: { status: true, lastError: true },
    });

    await this.audit.recordBestEffort({
      operatorId: operator.id,
      action: OPS_AUDIT_ACTIONS.paymentEventRecovered,
      targetType: OPS_AUDIT_TARGETS.paymentWebhookEvent,
      targetId: id,
      reason: `${reason} — desfecho: ${desfecho}`,
      result: desfecho === 'processed' ? OpsAuditResult.success : OpsAuditResult.failure,
      operationId,
      beforeState: { status: WebhookEventStatus.failed },
      afterState: { status: depois.status },
    });

    return { id, outcome: desfecho, status: depois.status, lastError: depois.lastError };
  }
}
