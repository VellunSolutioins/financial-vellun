import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OpsAuditResult, OpsRole } from '@prisma/client';

import { OpsExemptionsService } from './ops-exemptions.service';

const admin = {
  id: 'op-1',
  githubLogin: 'admin',
  role: OpsRole.ops_admin,
  canViewSensitive: false,
};

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'ex-1',
  name: 'Maria Souza',
  phone: '(41) 99999-8888',
  phoneNumber: '+5541999998888',
  note: 'sócia',
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  updatedByOperatorId: 'op-1',
  updatedBy: { githubLogin: 'admin' },
  ...overrides,
});

function setup({
  existing = row() as ReturnType<typeof row> | null,
  duplicate = null as { name: string } | null,
} = {}) {
  const tx = {
    subscriptionExemption: {
      findUnique: jest.fn().mockResolvedValue(existing),
      findFirst: jest.fn().mockResolvedValue(duplicate),
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve(row({ ...data, id: 'ex-new' }))),
      update: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ ...existing, ...data })),
      delete: jest.fn().mockResolvedValue(existing),
    },
  };
  const prisma = {
    subscriptionExemption: { findMany: jest.fn().mockResolvedValue(existing ? [existing] : []) },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
  } as any;
  const audit = { record: jest.fn().mockResolvedValue('audit-1') } as any;
  return { service: new OpsExemptionsService(prisma, audit), tx, audit };
}

describe('OpsExemptionsService', () => {
  it('lista com o telefone como cadastrado', async () => {
    const { service } = setup();
    expect(await service.list()).toEqual([
      expect.objectContaining({ name: 'Maria Souza', phone: '(41) 99999-8888' }),
    ]);
  });

  it('cadastra com o E.164 normalizado e audita com o telefone mascarado', async () => {
    const { service, tx, audit } = setup({ existing: null });

    const created = await service.create(
      { name: ' João Lima ', phone: '(11) 98888-7777', note: 'sócio fundador' },
      admin,
    );

    expect(created).toMatchObject({ id: 'ex-new', name: 'João Lima', phone: '(11) 98888-7777' });
    expect(tx.subscriptionExemption.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: 'João Lima',
          phone: '(11) 98888-7777',
          phoneNumber: '+5511988887777',
          note: 'sócio fundador',
          updatedByOperatorId: 'op-1',
        },
      }),
    );
    // A busca de repetido cobre o número sem o nono dígito.
    expect(tx.subscriptionExemption.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { phoneNumber: { in: ['+5511988887777', '+551188887777'] } },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: 'op-1',
        action: 'ops.exemption.created',
        targetType: 'subscription_exemption',
        targetId: 'ex-new',
        reason: 'sócio fundador',
        result: OpsAuditResult.success,
        afterState: { name: 'João Lima', phone: '5511*******77', note: 'sócio fundador' },
      }),
      tx,
    );
  });

  it('número já isento responde 409 e não grava nada', async () => {
    const { service, tx, audit } = setup({ existing: null, duplicate: { name: 'Maria Souza' } });

    await expect(
      service.create({ name: 'Outra', phone: '(41) 99999-8888' }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.subscriptionExemption.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('edita o telefone (renormalizado) e grava antes e depois', async () => {
    const { service, tx, audit } = setup();

    await service.update('ex-1', { phone: '(41) 98888-1111', name: 'Maria Souza' }, admin);

    expect(tx.subscriptionExemption.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: 'ex-1' } }),
      }),
    );
    expect(tx.subscriptionExemption.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          phone: '(41) 98888-1111',
          phoneNumber: '+5541988881111',
          updatedByOperatorId: 'op-1',
        },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ops.exemption.updated',
        beforeState: expect.objectContaining({ name: 'Maria Souza' }),
      }),
      tx,
    );
  });

  it('sem mudança responde 400; inexistente, 404', async () => {
    const { service } = setup();
    await expect(
      service.update('ex-1', { name: 'Maria Souza', note: 'sócia' }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);

    const missing = setup({ existing: null });
    await expect(missing.service.update('x', { name: 'Nova' }, admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(missing.service.remove('x', 'motivo', admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('exclui e audita com a justificativa', async () => {
    const { service, tx, audit } = setup();

    await service.remove('ex-1', 'saiu da sociedade', admin);

    expect(tx.subscriptionExemption.delete).toHaveBeenCalledWith({ where: { id: 'ex-1' } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ops.exemption.deleted',
        reason: 'saiu da sociedade',
        beforeState: expect.objectContaining({ name: 'Maria Souza' }),
      }),
      tx,
    );
  });
});
