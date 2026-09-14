import { WebhookEventStatus } from '@prisma/client';

import { WebhookRetryService } from './webhook-retry.service';

const agora = new Date('2026-09-11T12:00:00.000Z');

function setup(vencidos: { id: string }[] = [{ id: 'evt-1' }], presos = 0) {
  const prisma = {
    paymentWebhookEvent: {
      findMany: jest.fn().mockResolvedValue(vencidos),
      updateMany: jest.fn().mockResolvedValue({ count: presos }),
      count: jest.fn().mockResolvedValue(vencidos.length),
    },
  } as any;

  const processor = { attempt: jest.fn().mockResolvedValue('processed') } as any;
  const metrics = {
    setPaymentWebhookPendingRetry: jest.fn(),
    observePaymentWebhook: jest.fn(),
  } as any;

  return {
    service: new WebhookRetryService(prisma, processor, metrics),
    prisma,
    processor,
    metrics,
  };
}

describe('WebhookRetryService', () => {
  afterEach(() => jest.useRealTimers());

  it('só pega o que já venceu, e o mais antigo primeiro', async () => {
    jest.useFakeTimers().setSystemTime(agora);
    const { service, prisma } = setup();

    await service.sweep();

    const [args] = prisma.paymentWebhookEvent.findMany.mock.calls[0];
    expect(args.where.status).toBe(WebhookEventStatus.failed);
    expect(args.where.nextRetryAt.lte).toEqual(agora);
    // Um evento que espera há duas horas não pode ficar atrás de um que acabou
    // de falhar.
    expect(args.orderBy).toEqual({ nextRetryAt: 'asc' });
  });

  it('devolve à fila o que ficou preso em processing', async () => {
    jest.useFakeTimers().setSystemTime(agora);
    const { service, prisma } = setup([], 3);

    const resumo = await service.sweep();

    const [args] = prisma.paymentWebhookEvent.updateMany.mock.calls[0];
    expect(args.where.status).toBe(WebhookEventStatus.processing);
    expect(args.where.attemptedAt.lt).toEqual(new Date(agora.getTime() - 15 * 60 * 1000));
    // Volta como `failed` para passar pelo mesmo caminho de todo mundo —
    // reivindicação atômica e contagem de tentativas incluídas.
    expect(args.data).toEqual({ status: WebhookEventStatus.failed, nextRetryAt: agora });
    expect(resumo.destravados).toBe(3);
  });

  it('conta cada desfecho separadamente', async () => {
    const { service, processor } = setup([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
      { id: 'e' },
    ]);
    processor.attempt
      .mockResolvedValueOnce('processed')
      .mockResolvedValueOnce('retry_scheduled')
      .mockResolvedValueOnce('exhausted')
      .mockResolvedValueOnce('skipped')
      .mockResolvedValueOnce('unrecorded');

    const resumo = await service.sweep();

    expect(resumo).toMatchObject({
      tentados: 5,
      processados: 1,
      reagendados: 1,
      esgotados: 1,
      // A falha que nem pôde ser gravada tem contagem própria: somá-la aos
      // reagendados afirmaria um agendamento que não existe.
      naoRegistrados: 1,
    });
  });

  it('mede a fila de retry a cada ciclo', async () => {
    const { service, metrics } = setup([{ id: 'a' }, { id: 'b' }]);

    await service.sweep();

    // Vira gauge aqui, e nao num `collect()` por scrape: amarrar a coleta de
    // metrica ao Postgres apagaria o painel justamente quando ele vacila.
    expect(metrics.setPaymentWebhookPendingRetry).toHaveBeenCalledWith(2);
  });

  it('limita o lote por ciclo', async () => {
    const { service, prisma } = setup();

    await service.sweep();

    const [args] = prisma.paymentWebhookEvent.findMany.mock.calls[0];
    expect(args.take).toBe(50);
  });

  it('nada vencido é caminho normal, sem tentativa nenhuma', async () => {
    const { service, processor } = setup([]);

    const resumo = await service.sweep();

    expect(processor.attempt).not.toHaveBeenCalled();
    expect(resumo.tentados).toBe(0);
  });

  it('falha da varredura não derruba o processo', async () => {
    const { service, prisma } = setup();
    prisma.paymentWebhookEvent.updateMany.mockRejectedValue(new Error('banco fora'));

    await expect(service.sweep()).resolves.toMatchObject({ tentados: 0 });
  });

  it('não roda dois ciclos ao mesmo tempo', async () => {
    const { service, prisma } = setup();
    let liberar!: () => void;
    prisma.paymentWebhookEvent.updateMany.mockReturnValue(
      new Promise((resolve) => {
        liberar = () => resolve({ count: 0 });
      }),
    );

    const primeiro = service.sweep();
    const segundo = await service.sweep();

    expect(segundo.tentados).toBe(0);
    expect(prisma.paymentWebhookEvent.findMany).not.toHaveBeenCalled();
    liberar();
    await primeiro;
  });
});
