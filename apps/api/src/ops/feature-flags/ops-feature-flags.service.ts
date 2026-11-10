import type { FeatureKey } from '@financial-vellun/shared';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OpsAuditResult, Prisma } from '@prisma/client';

import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  isFeatureKey,
} from '../../feature-flags/feature-flags.catalog';
import { PrismaService } from '../../prisma/prisma.service';
import { OpsAuditService } from '../audit/ops-audit.service';
import { CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';
import { UpdateFeatureFlagDto } from './dto/update-feature-flag.dto';

/** Flag como devolvida ao painel. */
export interface FeatureFlagView {
  key: FeatureKey;
  label: string;
  description: string;
  enabled: boolean;
  /** `true` enquanto ninguém mexeu na flag e vale o default do catálogo. */
  isDefault: boolean;
  updatedAt: Date | null;
  updatedBy: { githubLogin: string } | null;
}

const FLAG_SELECT = {
  key: true,
  enabled: true,
  updatedAt: true,
  updatedBy: { select: { githubLogin: true } },
} satisfies Prisma.FeatureFlagSelect;

type FlagRow = Prisma.FeatureFlagGetPayload<{ select: typeof FLAG_SELECT }>;

@Injectable()
export class OpsFeatureFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OpsAuditService,
  ) {}

  /** Uma linha por item do catálogo, na ordem dele — inclusive as que nunca foram alteradas. */
  async list(): Promise<FeatureFlagView[]> {
    const rows = await this.prisma.featureFlag.findMany({
      where: { key: { in: FEATURE_KEYS } },
      select: FLAG_SELECT,
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return FEATURE_KEYS.map((key) => this.toView(key, byKey.get(key) ?? null));
  }

  /**
   * Liga ou desliga a flag para todos os usuários.
   *
   * Mesma regra de {@link OpsOperatorsService.update}: a alteração e a linha de
   * auditoria (com antes e depois) vão na mesma transação, porque desligar uma
   * funcionalidade de todos os clientes sem rastro é pior do que falhar.
   */
  async update(
    key: string,
    dto: UpdateFeatureFlagDto,
    actor: CurrentOpsOperator,
  ): Promise<FeatureFlagView> {
    if (!isFeatureKey(key)) throw new NotFoundException('Funcionalidade não encontrada.');

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.featureFlag.findUnique({ where: { key }, select: FLAG_SELECT });
      const before = current?.enabled ?? FEATURE_CATALOG[key].defaultEnabled;
      if (before === dto.enabled) throw new BadRequestException('Nada a alterar.');

      const after = await tx.featureFlag.upsert({
        where: { key },
        create: { key, enabled: dto.enabled, updatedByOperatorId: actor.id },
        update: { enabled: dto.enabled, updatedByOperatorId: actor.id },
        select: FLAG_SELECT,
      });

      await this.audit.record(
        {
          operatorId: actor.id,
          action: OPS_AUDIT_ACTIONS.featureFlagUpdated,
          targetType: OPS_AUDIT_TARGETS.featureFlag,
          targetId: key,
          reason: dto.reason,
          result: OpsAuditResult.success,
          beforeState: { enabled: before },
          afterState: { enabled: after.enabled },
        },
        tx,
      );

      return this.toView(key, after);
    });
  }

  private toView(key: FeatureKey, row: FlagRow | null): FeatureFlagView {
    const definition = FEATURE_CATALOG[key];
    return {
      key,
      label: definition.label,
      description: definition.description,
      enabled: row?.enabled ?? definition.defaultEnabled,
      isDefault: row === null,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  }
}
