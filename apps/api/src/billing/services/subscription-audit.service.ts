import { Injectable } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export interface RecordAuditInput {
  subscriptionId: string;
  action: string;
  previousStatus?: SubscriptionStatus | null;
  newStatus?: SubscriptionStatus | null;
  /** Origem da alteração: ex. `webhook`, `system`, `reconciliation`, `admin:<id>`. */
  actor?: string | null;
  reason?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Registra transições e alterações de assinatura na tabela de auditoria
 * (estado anterior/posterior, origem, ator) — doc seção 4.5.
 */
@Injectable()
export class SubscriptionAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditInput) {
    return this.prisma.subscriptionAudit.create({
      data: {
        subscriptionId: input.subscriptionId,
        action: input.action,
        previousStatus: input.previousStatus ?? null,
        newStatus: input.newStatus ?? null,
        actor: input.actor ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata,
      },
    });
  }
}
