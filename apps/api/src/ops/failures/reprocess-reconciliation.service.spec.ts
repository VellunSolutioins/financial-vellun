import { OpsAuditResult, OpsFailureStatus } from '@prisma/client';

import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';
import {
  RECONCILIACAO_APOS_MINUTOS,
  ReprocessReconciliationService,
} from './reprocess-reconciliation.service';

const agora = new Date('2026-09-11T12:00:00.000Z');

function setup(
  presas: { id: string }[] = [{ id: 'falha-1' }],
  solicitacao: unknown = { operatorId: 'op-1', operationId: 'oper-1' },
) {
  const prisma = {
    opsFailedMessage: {
      findMany: jest.fn().mockResolvedValue(presas),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    opsAuditLog: {
      findFirst: jest.fn().mockResolvedValue(solicitacao),
    },
  } as any;

  const audit = { recordBestEffort: jest.fn().mockResolvedValue(undefined) } as any;

  return { service: new ReprocessReconciliationService(prisma, audit), prisma, audit };
}

describe('ReprocessReconciliationService', () => {
  afterEach(() => jest.useRealTimers());

  it('só olha linhas paradas além do limite', async () => {
    jest.useFakeTimers().setSystemTime(agora);
    const { service, prisma } = setup();

    await service.reconcile();

    const [args] = prisma.opsFailedMessage.findMany.mock.calls[0];
    expect(args.where.status).toBe(OpsFailureStatus.reprocessing);
    expect(args.where.updatedAt.lt).toEqual(
      new Date(agora.getTime() - RECONCILIACAO_APOS_MINUTOS * 60 * 1000),
    );
  });

  it('devolve a pending exigindo que ainda esteja em reprocessing', async () => {
    const { service, prisma } = setup();

    const devolvidas = await service.reconcile();

    const [args] = prisma.opsFailedMessage.updateMany.mock.calls[0];
    // Sem o status no `where`, o cron sobrescreveria uma linha que acabou de ser
    // marcada `reprocessed` entre a leitura e a escrita.
    expect(args.where).toEqual({ id: 'falha-1', status: OpsFailureStatus.reprocessing });
    expect(args.data).toEqual({ status: OpsFailureStatus.pending });
    expect(devolvidas).toBe(1);
  });

  it('atribui a linha ao operador que pediu, na mesma operação', async () => {
    const { service, audit, prisma } = setup();

    await service.reconcile();

    const [busca] = prisma.opsAuditLog.findFirst.mock.calls[0];
    expect(busca.where).toMatchObject({
      targetType: OPS_AUDIT_TARGETS.failedMessage,
      targetId: 'falha-1',
      action: OPS_AUDIT_ACTIONS.failureReprocessRequested,
    });
    expect(audit.recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: 'op-1',
        operationId: 'oper-1',
        result: OpsAuditResult.failure,
      }),
    );
  });

  it('sem solicitação registrada, não inventa operador', async () => {
    const { service, audit } = setup([{ id: 'falha-1' }], null);

    const devolvidas = await service.reconcile();

    // A devolução acontece de qualquer forma: deixar a linha presa seria pior
    // do que ficar sem a linha de auditoria.
    expect(devolvidas).toBe(1);
    expect(audit.recordBestEffort).not.toHaveBeenCalled();
  });

  it('nada preso é caminho normal, sem escrita nenhuma', async () => {
    const { service, prisma, audit } = setup([]);

    expect(await service.reconcile()).toBe(0);
    expect(prisma.opsFailedMessage.updateMany).not.toHaveBeenCalled();
    expect(audit.recordBestEffort).not.toHaveBeenCalled();
  });

  it('falha do cron não derruba o processo', async () => {
    const { service, prisma } = setup();
    prisma.opsFailedMessage.findMany.mockRejectedValue(new Error('banco fora'));

    await expect(service.reconcile()).resolves.toBe(0);
  });

  it('não roda dois ciclos ao mesmo tempo', async () => {
    const { service, prisma } = setup();
    let liberar!: () => void;
    prisma.opsFailedMessage.findMany.mockReturnValue(
      new Promise((resolve) => {
        liberar = () => resolve([]);
      }),
    );

    const primeiro = service.reconcile();
    const segundo = await service.reconcile();

    expect(segundo).toBe(0);
    expect(prisma.opsFailedMessage.findMany).toHaveBeenCalledTimes(1);
    liberar();
    await primeiro;
  });
});
