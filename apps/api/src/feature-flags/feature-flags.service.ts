import type { FeatureFlags, FeatureKey } from '@financial-vellun/shared';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { FEATURE_CATALOG, FEATURE_KEYS, isFeatureKey } from './feature-flags.catalog';

/**
 * Leitura do estado das feature flags globais.
 *
 * **Sem cache em memória**, de propósito: a consulta é por chave primária numa
 * tabela de poucas linhas, e com mais de uma réplica da API um cache local
 * deixaria réplicas respondendo diferente depois de o /ops mudar uma flag.
 */
@Injectable()
export class FeatureFlagsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Todas as flags do catálogo, com o default onde não há linha. */
  async getAll(): Promise<FeatureFlags> {
    const rows = await this.prisma.featureFlag.findMany({
      where: { key: { in: FEATURE_KEYS } },
      select: { key: true, enabled: true },
    });

    const flags = Object.fromEntries(
      FEATURE_KEYS.map((key) => [key, FEATURE_CATALOG[key].defaultEnabled]),
    ) as FeatureFlags;
    for (const row of rows) {
      if (isFeatureKey(row.key)) flags[row.key] = row.enabled;
    }
    return flags;
  }

  async isEnabled(key: FeatureKey): Promise<boolean> {
    const row = await this.prisma.featureFlag.findUnique({
      where: { key },
      select: { enabled: true },
    });
    return row?.enabled ?? FEATURE_CATALOG[key].defaultEnabled;
  }
}
