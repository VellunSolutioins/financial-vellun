import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OpsAuditResult, OpsRole } from '@prisma/client';

import { OpsFeatureFlagsService } from './ops-feature-flags.service';

const admin = {
  id: 'op-1',
  githubLogin: 'admin',
  role: OpsRole.ops_admin,
  canViewSensitive: false,
};

function setup(existing: { key: string; enabled: boolean } | null = null) {
  const tx = {
    featureFlag: {
      findUnique: jest
        .fn()
        .mockResolvedValue(existing && { ...existing, updatedAt: new Date(), updatedBy: null }),
      upsert: jest.fn().mockImplementation(({ where, create, update }: any) =>
        Promise.resolve({
          key: where.key,
          enabled: (existing ? update : create).enabled,
          updatedAt: new Date('2026-11-09T12:00:00Z'),
          updatedBy: { githubLogin: 'admin' },
        }),
      ),
    },
  };
  const prisma = {
    featureFlag: { findMany: jest.fn().mockResolvedValue(existing ? [existing] : []) },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
  } as any;
  const audit = { record: jest.fn().mockResolvedValue('audit-1') } as any;
  return { service: new OpsFeatureFlagsService(prisma, audit), tx, audit };
}

describe('OpsFeatureFlagsService', () => {
  it('lista todo o catálogo, marcando as flags que ainda usam o default', async () => {
    const { service } = setup({ key: 'notes', enabled: false });
    const list = await service.list();

    expect(list.map((flag) => flag.key)).toEqual(['agenda', 'notes']);
    expect(list[0]).toMatchObject({
      key: 'agenda',
      enabled: true,
      isDefault: true,
      updatedBy: null,
    });
    expect(list[1]).toMatchObject({ key: 'notes', enabled: false, isDefault: false });
  });

  it('desliga a flag e grava antes e depois na auditoria, na mesma transação', async () => {
    const { service, tx, audit } = setup();

    const result = await service.update(
      'notes',
      { enabled: false, reason: 'bug em produção' },
      admin,
    );

    expect(result).toMatchObject({ key: 'notes', enabled: false, isDefault: false });
    expect(tx.featureFlag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { key: 'notes', enabled: false, updatedByOperatorId: 'op-1' },
      }),
    );
    // O `tx` como segundo argumento é o que amarra a auditoria à alteração.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: 'op-1',
        action: 'ops.feature_flag.updated',
        targetType: 'feature_flag',
        targetId: 'notes',
        reason: 'bug em produção',
        result: OpsAuditResult.success,
        beforeState: { enabled: true },
        afterState: { enabled: false },
      }),
      tx,
    );
  });

  it('recusa com 400 quando o estado pedido já é o atual', async () => {
    // Inclusive contra o default: ligar o que nunca foi desligado não gera linha nem auditoria.
    const { service, tx, audit } = setup();
    await expect(
      service.update('agenda', { enabled: true, reason: 'garantir' }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.featureFlag.upsert).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('recusa com 404 chave fora do catálogo', async () => {
    const { service } = setup();
    await expect(
      service.update('inexistente', { enabled: false, reason: 'teste' }, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
