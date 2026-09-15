import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OpsAuditResult, OpsRole } from '@prisma/client';

import { OpsOperatorsService } from './ops-operators.service';

const alvo = {
  id: 'op-2',
  githubLogin: 'outro',
  role: OpsRole.viewer,
  active: false,
  canViewSensitive: false,
};

const admin = {
  id: 'op-1',
  githubLogin: 'admin',
  role: OpsRole.ops_admin,
  canViewSensitive: true,
};

/**
 * Aplica `data` como o Prisma aplicaria: chave com `undefined` significa "não
 * alterar", não "gravar undefined". Sem isso o dublê inventaria um estado que o
 * banco nunca produziria — e o teste passaria a verificar o mock.
 */
function applyUpdate(row: Record<string, unknown>, data: Record<string, unknown>) {
  const defined = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
  return { ...row, ...defined };
}

function setup(existing: Record<string, unknown> | null = alvo) {
  const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
  const tx = {
    opsOperator: {
      update: jest
        .fn()
        .mockImplementation(({ data }: any) =>
          Promise.resolve(applyUpdate(existing ?? alvo, data)),
        ),
    },
    opsAuditLog: { create: auditCreate },
  };

  const prisma = {
    opsOperator: { findUnique: jest.fn().mockResolvedValue(existing), findMany: jest.fn() },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
  } as any;

  const audit = { newOperationId: jest.fn().mockReturnValue('oper-1') } as any;

  return { service: new OpsOperatorsService(prisma, audit), prisma, tx, auditCreate };
}

describe('OpsOperatorsService', () => {
  it('promove o operador e grava antes e depois na auditoria', async () => {
    const { service, auditCreate } = setup();

    const result = await service.update(
      'op-2',
      { role: OpsRole.operator, active: true, reason: 'entrou no time de plantão' },
      admin as any,
    );

    expect(result).toMatchObject({ role: OpsRole.operator, active: true });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operatorId: 'op-1',
        targetId: 'op-2',
        reason: 'entrou no time de plantão',
        result: OpsAuditResult.success,
        beforeState: { role: OpsRole.viewer, active: false, canViewSensitive: false },
        afterState: { role: OpsRole.operator, active: true, canViewSensitive: false },
      }),
    });
  });

  it('grava a alteração e a auditoria na mesma transação', async () => {
    // Uma promoção sem linha de auditoria é pior que uma que falhou: ninguém a vê.
    const { service, prisma } = setup();

    await service.update('op-2', { active: true, reason: 'ativação' }, admin as any);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('recusa operador inexistente', async () => {
    const { service } = setup(null);

    await expect(
      service.update('nao-existe', { active: true, reason: 'x' }, admin as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('recusa requisição que não altera nada', async () => {
    const { service } = setup();

    await expect(
      service.update('op-2', { reason: 'sem campos' }, admin as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('impede o ops_admin de remover o próprio papel', async () => {
    // Sem isso o último admin se tranca fora e a saída é mexer no banco à mão.
    const { service } = setup({ ...alvo, id: 'op-1', role: OpsRole.ops_admin, active: true });

    await expect(
      service.update('op-1', { role: OpsRole.viewer, reason: 'saindo' }, admin as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('impede o ops_admin de se desativar', async () => {
    const { service } = setup({ ...alvo, id: 'op-1', role: OpsRole.ops_admin, active: true });

    await expect(
      service.update('op-1', { active: false, reason: 'férias' }, admin as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('permite ao ops_admin alterar a própria permissão de dado sensível', async () => {
    // Não é perda de acesso administrativo: continua podendo se reconceder.
    const { service } = setup({ ...alvo, id: 'op-1', role: OpsRole.ops_admin, active: true });

    await expect(
      service.update('op-1', { canViewSensitive: false, reason: 'não preciso mais' }, admin as any),
    ).resolves.toBeDefined();
  });

  it('permite rebaixar outro ops_admin', async () => {
    const { service } = setup({ ...alvo, id: 'op-3', role: OpsRole.ops_admin, active: true });

    await expect(
      service.update('op-3', { role: OpsRole.operator, reason: 'trocou de time' }, admin as any),
    ).resolves.toBeDefined();
  });
});
