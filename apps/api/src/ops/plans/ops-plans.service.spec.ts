import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OpsAuditResult, OpsRole, Prisma } from '@prisma/client';

import { OpsPlansService } from './ops-plans.service';

const admin = {
  id: 'op-1',
  githubLogin: 'admin',
  role: OpsRole.ops_admin,
  canViewSensitive: false,
};

const plan = (overrides: Record<string, unknown> = {}) => ({
  id: 'plan-1',
  code: 'zeloo-mensal',
  name: 'Zeloo Mensal',
  description: null,
  price: new Prisma.Decimal('49.90'),
  currency: 'BRL',
  interval: 'monthly',
  isActive: true,
  features: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  _count: { subscriptions: 0 },
  ...overrides,
});

function setup(existing: ReturnType<typeof plan> | null = plan()) {
  const tx = {
    plan: {
      findUnique: jest.fn().mockResolvedValue(existing),
      create: jest
        .fn()
        .mockImplementation(({ data }: any) =>
          Promise.resolve(plan({ ...data, id: 'plan-new', price: new Prisma.Decimal(data.price) })),
        ),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          ...existing,
          ...data,
          ...(data.price !== undefined && { price: new Prisma.Decimal(data.price) }),
        }),
      ),
      delete: jest.fn().mockResolvedValue(existing),
    },
  };
  const prisma = {
    plan: { findMany: jest.fn().mockResolvedValue(existing ? [existing] : []) },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
  } as any;
  const audit = { record: jest.fn().mockResolvedValue('audit-1') } as any;
  return { service: new OpsPlansService(prisma, audit), tx, audit };
}

describe('OpsPlansService', () => {
  it('lista os planos com preço em string e o número de assinaturas', async () => {
    const { service } = setup(plan({ _count: { subscriptions: 3 } }));

    expect(await service.list()).toEqual([
      expect.objectContaining({ code: 'zeloo-mensal', price: '49.90', subscriptionCount: 3 }),
    ]);
  });

  it('cria o plano e grava a auditoria na mesma transação', async () => {
    const { service, tx, audit } = setup(null);

    const created = await service.create(
      {
        code: 'zeloo-anual',
        name: ' Zeloo Anual ',
        description: '',
        price: '499.00',
        interval: 'annual',
        isActive: false,
        reason: 'lançamento do anual',
      },
      admin,
    );

    expect(created).toMatchObject({ id: 'plan-new', name: 'Zeloo Anual', price: '499.00' });
    expect(tx.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'Zeloo Anual', description: null, isActive: false }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: 'op-1',
        action: 'ops.plan.created',
        targetType: 'plan',
        targetId: 'plan-new',
        reason: 'lançamento do anual',
        result: OpsAuditResult.success,
        afterState: expect.objectContaining({ code: 'zeloo-anual', price: '499.00' }),
      }),
      tx,
    );
  });

  it('código repetido responde 409', async () => {
    const { service, tx } = setup(null);
    tx.plan.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicado', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.create(
        {
          code: 'zeloo-mensal',
          name: 'Outro',
          price: '10.00',
          interval: 'monthly',
          isActive: true,
          reason: 'teste',
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('edita preço e exibição e grava antes e depois', async () => {
    const { service, tx, audit } = setup();

    const updated = await service.update(
      'plan-1',
      { price: '59.90', isActive: false, name: 'Zeloo Mensal', reason: 'reajuste' },
      admin,
    );

    expect(updated).toMatchObject({ price: '59.90', isActive: false });
    // Nome igual não entra na alteração.
    expect(tx.plan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { price: '59.90', isActive: false } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ops.plan.updated',
        beforeState: expect.objectContaining({ price: '49.90', isActive: true }),
        afterState: expect.objectContaining({ price: '59.90', isActive: false }),
      }),
      tx,
    );
  });

  it('sem mudança de verdade responde 400; plano inexistente, 404', async () => {
    const { service } = setup();
    await expect(
      service.update('plan-1', { price: '49.9', reason: 'nada' }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);

    const missing = setup(null);
    await expect(
      missing.service.update('x', { name: 'Novo', reason: 'teste' }, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('plano com assinaturas não muda de ciclo nem é excluído', async () => {
    const { service, tx, audit } = setup(plan({ _count: { subscriptions: 2 } }));

    await expect(
      service.update('plan-1', { interval: 'annual', reason: 'trocar ciclo' }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(service.remove('plan-1', 'limpeza', admin)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.plan.delete).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('exclui plano sem assinaturas e audita o estado anterior', async () => {
    const { service, tx, audit } = setup();

    await service.remove('plan-1', 'criado por engano', admin);

    expect(tx.plan.delete).toHaveBeenCalledWith({ where: { id: 'plan-1' } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ops.plan.deleted',
        reason: 'criado por engano',
        beforeState: expect.objectContaining({ code: 'zeloo-mensal' }),
      }),
      tx,
    );
  });
});
