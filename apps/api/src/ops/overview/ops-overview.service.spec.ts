import { OpsFailureStatus, WebhookEventStatus } from '@prisma/client';

import { OpsOverviewService } from './ops-overview.service';

const agora = new Date('2026-09-10T12:00:00.000Z');

function setup(overrides: Record<string, unknown> = {}) {
  const prisma = {
    opsFailedMessage: {
      count: jest.fn().mockResolvedValue(4),
      findFirst: jest.fn().mockResolvedValue({ capturedAt: new Date('2026-09-01T10:00:00.000Z') }),
      groupBy: jest.fn().mockResolvedValue([{ errorType: 'ConnectionError', _count: { _all: 3 } }]),
    },
    paymentWebhookEvent: {
      count: jest.fn().mockResolvedValue(2),
      findFirst: jest.fn().mockResolvedValue({ receivedAt: new Date('2026-09-09T08:00:00.000Z') }),
      groupBy: jest
        .fn()
        .mockResolvedValue([{ status: WebhookEventStatus.failed, _count: { _all: 2 } }]),
    },
    ...overrides,
  } as any;

  const failures = {
    countByStatus: jest
      .fn()
      .mockResolvedValue({ pending: 3, reprocessing: 0, reprocessed: 1, discarded: 0 }),
  } as any;

  const grafana = { dashboards: jest.fn().mockReturnValue([]) } as any;

  return { service: new OpsOverviewService(prisma, failures, grafana), prisma, grafana };
}

describe('OpsOverviewService', () => {
  it('agrupa os tipos de erro só entre as pendentes, e no máximo cinco', async () => {
    const { service, prisma } = setup();

    const resumo = await service.build();

    const [args] = prisma.opsFailedMessage.groupBy.mock.calls[0];
    // Pendente é o conjunto acionável: o que já foi reprocessado não é dívida.
    expect(args.where).toEqual({ status: OpsFailureStatus.pending });
    expect(args.take).toBe(5);
    expect(resumo.failures.topErrorTypes).toEqual([{ errorType: 'ConnectionError', count: 3 }]);
  });

  it('devolve todos os status de pagamento, inclusive os zerados', async () => {
    const { service } = setup();

    const resumo = await service.build();

    // Omitir o zero faria parecer que a informação não existe.
    expect(resumo.payments.byStatus).toEqual({
      received: 0,
      processing: 0,
      processed: 0,
      failed: 2,
    });
  });

  it('mede as últimas 24h sobre a captura, não sobre a falha original', async () => {
    jest.useFakeTimers().setSystemTime(agora);
    const { service, prisma } = setup();

    await service.build();

    const [{ where }] = prisma.opsFailedMessage.count.mock.calls[0];
    expect(where.capturedAt.gte).toEqual(new Date('2026-09-09T12:00:00.000Z'));
    jest.useRealTimers();
  });

  it('conta como pendente mais antiga a de menor capturedAt', async () => {
    const { service, prisma } = setup();

    const resumo = await service.build();

    const [args] = prisma.opsFailedMessage.findFirst.mock.calls[0];
    expect(args.where.status).toBe(OpsFailureStatus.pending);
    expect(args.orderBy).toEqual({ capturedAt: 'asc' });
    expect(resumo.failures.oldestPendingAt).toEqual(new Date('2026-09-01T10:00:00.000Z'));
  });

  it('trata ausência de pendente e de webhook em aberto como null, não como erro', async () => {
    const { service } = setup({
      opsFailedMessage: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      paymentWebhookEvent: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    });

    const resumo = await service.build();

    expect(resumo.failures.oldestPendingAt).toBeNull();
    expect(resumo.payments.oldestUnresolvedAt).toBeNull();
    expect(resumo.failures.topErrorTypes).toEqual([]);
  });

  it('só considera em aberto o webhook que ainda não foi processado', async () => {
    const { service, prisma } = setup();

    await service.build();

    const [args] = prisma.paymentWebhookEvent.findFirst.mock.calls[0];
    expect(args.where.status.in).toEqual(['received', 'processing', 'failed']);
  });
});
