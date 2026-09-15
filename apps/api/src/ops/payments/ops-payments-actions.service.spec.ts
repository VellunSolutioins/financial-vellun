import { NotFoundException } from '@nestjs/common';
import { OpsAuditResult, OpsRole, WebhookEventStatus } from '@prisma/client';

import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';
import { OpsPaymentsActionsService } from './ops-payments-actions.service';

const operador = {
  id: 'op-1',
  githubLogin: 'operador',
  role: OpsRole.operator,
  canViewSensitive: false,
};

function setup(
  statusAtual: WebhookEventStatus | null = WebhookEventStatus.exhausted,
  desfecho = 'processed',
  statusFinal: WebhookEventStatus = WebhookEventStatus.processed,
) {
  const prisma: any = {
    paymentWebhookEvent: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          statusAtual ? { status: statusAtual, attempts: 5, lastError: 'PSP fora' } : null,
        ),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ status: statusFinal, lastError: null }),
      updateMany: jest.fn(({ where }: any) =>
        Promise.resolve({ count: where.status === statusAtual ? 1 : 0 }),
      ),
    },
  };
  prisma.$transaction = jest.fn((fn: any) => fn(prisma));

  const audit = {
    newOperationId: jest.fn().mockReturnValue('oper-1'),
    record: jest.fn().mockResolvedValue('audit-1'),
    recordBestEffort: jest.fn().mockResolvedValue(undefined),
  } as any;

  const processor = { attempt: jest.fn().mockResolvedValue(desfecho) } as any;

  return {
    service: new OpsPaymentsActionsService(prisma, audit, processor),
    prisma,
    audit,
    processor,
  };
}

describe('OpsPaymentsActionsService.recover', () => {
  it('devolve o evento à fila e roda uma tentativa de verdade', async () => {
    const { service, prisma, processor } = setup();

    const resultado = await service.recover('evt-1', 'PSP normalizado', operador);

    const [args] = prisma.paymentWebhookEvent.updateMany.mock.calls[0];
    expect(args.where.status).toBe(WebhookEventStatus.exhausted);
    expect(args.data.status).toBe(WebhookEventStatus.failed);
    // Mudar status no banco não é reprocessar: a tentativa acontece de fato.
    expect(processor.attempt).toHaveBeenCalledWith('evt-1');
    expect(resultado).toMatchObject({ outcome: 'processed', status: 'processed' });
  });

  it('não age sobre evento que ainda tem retry agendado', async () => {
    for (const status of [
      WebhookEventStatus.failed,
      WebhookEventStatus.received,
      WebhookEventStatus.processing,
      WebhookEventStatus.processed,
    ]) {
      const { service, processor } = setup(status);

      const resultado = await service.recover('evt-1', 'tentando', operador);

      // Recuperar um `failed` reprocessaria por cima de um retry em andamento —
      // é para isso que os dois estados são separados.
      expect(resultado.outcome).toBe('skipped');
      expect(processor.attempt).not.toHaveBeenCalled();
    }
  });

  it('404 quando o evento não existe', async () => {
    const { service } = setup(null);

    await expect(service.recover('sumiu', 'motivo', operador)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('registra a solicitação na MESMA transação da reivindicação', async () => {
    const { service, prisma, audit } = setup();

    await service.recover('evt-1', 'PSP normalizado', operador);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: OPS_AUDIT_ACTIONS.paymentEventRecovered,
        targetType: OPS_AUDIT_TARGETS.paymentWebhookEvent,
        beforeState: { status: WebhookEventStatus.exhausted, attempts: 5 },
      }),
      prisma,
    );
  });

  it('uma tentativa que falha de novo é registrada como falha', async () => {
    const { service, audit } = setup(
      WebhookEventStatus.exhausted,
      'exhausted',
      WebhookEventStatus.exhausted,
    );

    const resultado = await service.recover('evt-1', 'tentando de novo', operador);

    expect(resultado.outcome).toBe('exhausted');
    expect(audit.recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ result: OpsAuditResult.failure, operationId: 'oper-1' }),
    );
  });

  it('as duas linhas da recuperação compartilham o operationId', async () => {
    const { service, audit } = setup();

    await service.recover('evt-1', 'PSP normalizado', operador);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'oper-1' }),
      expect.anything(),
    );
    expect(audit.recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'oper-1' }),
    );
  });
});
