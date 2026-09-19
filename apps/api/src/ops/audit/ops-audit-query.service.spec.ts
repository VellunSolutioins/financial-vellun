import { NotFoundException } from '@nestjs/common';
import { OpsAuditResult } from '@prisma/client';

import { OpsAuditQueryService } from './ops-audit-query.service';

const linha = {
  id: 'audit-1',
  action: 'ops.failure.sensitive_viewed',
  targetType: 'ops_failed_message',
  targetId: 'falha-1',
  reason: 'visualização do payload em claro',
  result: OpsAuditResult.success,
  operationId: '3f1c1f52-0d0e-4a2f-9f0e-9f1f2a3b4c5d',
  createdAt: new Date('2026-09-10T11:00:00.000Z'),
  operator: { id: 'op-2', githubLogin: 'investigador' },
};

function setup(
  encontrada: unknown = { ...linha, beforeState: null, afterState: { role: 'operator' } },
) {
  const prisma = {
    opsAuditLog: {
      findMany: jest.fn().mockResolvedValue([linha]),
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn().mockResolvedValue(encontrada),
    },
    $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
  } as any;

  return { service: new OpsAuditQueryService(prisma), prisma };
}

describe('OpsAuditQueryService', () => {
  it('resolve o operador na listagem: um UUID não responde "quem fez"', async () => {
    const { service, prisma } = setup();

    const { items } = await service.list({});

    const [args] = prisma.opsAuditLog.findMany.mock.calls[0];
    expect(args.select.operator).toEqual({ select: { id: true, githubLogin: true } });
    expect(items[0].operator.githubLogin).toBe('investigador');
  });

  it('deixa estado anterior e posterior fora da listagem', async () => {
    const { service, prisma } = setup();

    await service.list({});

    const [args] = prisma.opsAuditLog.findMany.mock.calls[0];
    expect(args.select).not.toHaveProperty('beforeState');
    expect(args.select).not.toHaveProperty('afterState');
  });

  it('pagina com 10 por padrão, mais recentes primeiro', async () => {
    const { service, prisma } = setup();

    const resultado = await service.list({ page: 3 });

    const [args] = prisma.opsAuditLog.findMany.mock.calls[0];
    expect(args.take).toBe(10);
    expect(args.skip).toBe(20);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(resultado).toMatchObject({ total: 1, page: 3, pageSize: 10 });
  });

  it('combina os filtros num único where', async () => {
    const { service, prisma } = setup();

    await service.list({
      operatorId: 'op-2',
      action: 'ops.failure.sensitive_viewed',
      targetType: 'ops_failed_message',
      targetId: 'falha-1',
      operationId: '9a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
      result: OpsAuditResult.denied,
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-10T00:00:00.000Z',
    });

    const [args] = prisma.opsAuditLog.findMany.mock.calls[0];
    expect(args.where).toEqual({
      operatorId: 'op-2',
      action: 'ops.failure.sensitive_viewed',
      targetType: 'ops_failed_message',
      targetId: 'falha-1',
      operationId: '9a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
      result: OpsAuditResult.denied,
      createdAt: {
        gte: new Date('2026-09-01T00:00:00.000Z'),
        lte: new Date('2026-09-10T00:00:00.000Z'),
      },
    });
  });

  describe('detail', () => {
    it('inclui estado anterior e posterior', async () => {
      const { service } = setup();

      const detalhe = await service.detail('audit-1');

      expect(detalhe.afterState).toEqual({ role: 'operator' });
    });

    it('404 quando o registro não existe', async () => {
      const { service } = setup(null);

      await expect(service.detail('sumiu')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
