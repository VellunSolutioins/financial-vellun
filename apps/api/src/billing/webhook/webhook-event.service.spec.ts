import { Prisma } from '@prisma/client';

import { WebhookEventService, sanitizePayload } from './webhook-event.service';

describe('sanitizePayload', () => {
  it('redige chaves sensíveis recursivamente', () => {
    const result = sanitizePayload({
      id: 'evt',
      payment: {
        value: 49.9,
        creditCard: { creditCardNumber: '4111111111111111', creditCardBrand: 'VISA' },
        creditCardToken: 'tok_secret',
      },
    }) as any;

    expect(result.id).toBe('evt');
    expect(result.payment.value).toBe(49.9);
    expect(result.payment.creditCard).toBe('[REDACTED]');
    expect(result.payment.creditCardToken).toBe('[REDACTED]');
  });

  it('preserva campos não sensíveis usados na correlação', () => {
    const result = sanitizePayload({
      payment: { id: 'pay_1', subscription: 'sub_a', customer: 'cus_a', status: 'RECEIVED' },
    }) as any;
    expect(result.payment).toEqual({
      id: 'pay_1',
      subscription: 'sub_a',
      customer: 'cus_a',
      status: 'RECEIVED',
    });
  });
});

describe('WebhookEventService.ingest', () => {
  function setup(createImpl: jest.Mock) {
    const prisma = { paymentWebhookEvent: { create: createImpl } } as any;
    const metrics = { observePaymentWebhook: jest.fn() } as any;
    return new WebhookEventService(prisma, metrics);
  }

  const event = {
    providerEventId: 'evt_1',
    eventType: 'PAYMENT_RECEIVED',
    payload: { id: 'evt_1' },
  };

  it('persiste o evento e retorna não-duplicado', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'row_1' });
    const service = setup(create);

    const result = await service.ingest(event);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ providerEventId: 'evt_1', status: 'received' }),
      }),
    );
    expect(result).toEqual({ duplicate: false, eventId: 'row_1' });
  });

  it('trata duplicado (P2002) como idempotente', async () => {
    const create = jest
      .fn()
      .mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
      );
    const service = setup(create);

    const result = await service.ingest(event);

    expect(result).toEqual({ duplicate: true, eventId: null });
  });
});

describe('WebhookEventService.markProcessed', () => {
  function setup() {
    const update = jest.fn().mockResolvedValue({});
    // O cliente de banco é o de quem chama (a transação do evento); o do
    // serviço não pode ser tocado.
    const prisma = { paymentWebhookEvent: { update: jest.fn() } } as any;
    const tx = { paymentWebhookEvent: { update } } as any;
    const metrics = { observePaymentWebhook: jest.fn() } as any;
    return { service: new WebhookEventService(prisma, metrics), prisma, tx, update, metrics };
  }

  it('fecha o evento e o liga à assinatura na mesma escrita, pela transação de quem chama', async () => {
    const { service, prisma, tx, update } = setup();

    await service.markProcessed('evt-1', 's1', tx);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'evt-1' },
      data: expect.objectContaining({
        status: 'processed',
        subscriptionId: 's1',
        lastError: null,
        nextRetryAt: null,
      }),
    });
    expect(prisma.paymentWebhookEvent.update).not.toHaveBeenCalled();
  });

  it('evento sem assinatura correlacionada não mexe na ligação', async () => {
    const { service, tx, update } = setup();

    await service.markProcessed('evt-1', null, tx);

    expect(update.mock.calls[0][0].data).not.toHaveProperty('subscriptionId');
  });

  it('não conta a métrica: ainda não houve commit', async () => {
    const { service, tx, metrics } = setup();

    await service.markProcessed('evt-1', 's1', tx);
    expect(metrics.observePaymentWebhook).not.toHaveBeenCalled();

    service.observeProcessed();
    expect(metrics.observePaymentWebhook).toHaveBeenCalledWith('processed');
  });
});

describe('WebhookEventService.markFailed', () => {
  /**
   * Dublê em que `update` grava o que recebeu e devolve a linha resultante, para
   * que o teste afirme o que o serviço decidiu — não o que o mock inventou.
   */
  function setup(attempts: number, leitura?: jest.Mock) {
    const paymentWebhookEvent = {
      findUniqueOrThrow: leitura ?? jest.fn().mockResolvedValue({ attempts }),
      update: jest.fn(async ({ data }: any) => ({ id: 'evt-1', attempts, ...data })),
    };
    const prisma: any = { paymentWebhookEvent };
    prisma.$transaction = jest.fn((fn: any) => fn(prisma));
    const metrics = { observePaymentWebhook: jest.fn() } as any;

    return { service: new WebhookEventService(prisma, metrics), prisma, metrics };
  }

  it('lê as tentativas e grava na MESMA transação', async () => {
    const { service, prisma } = setup(2);

    await service.markFailed('evt-1', 'PSP fora');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.paymentWebhookEvent.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'evt-1' },
      select: { attempts: true },
    });
  });

  it('agenda pelo número real de tentativas, não por palpite', async () => {
    const { service } = setup(4);

    const antes = Date.now();
    const linha = await service.markFailed('evt-1', 'PSP fora');

    // 4 tentativas feitas → bucket 3 (30 min). O fallback antigo de
    // `attempts = 1` teria agendado para 30 s.
    expect(linha.status).toBe('failed');
    const espera = (linha.nextRetryAt!.getTime() - antes) / 1000;
    expect(espera).toBeGreaterThanOrEqual(1800 - 1);
    expect(espera).toBeLessThan(1800 + 5);
  });

  it('a quinta falha ainda espera o último bucket; só a sexta esgota', async () => {
    const quinta = await setup(5).service.markFailed('evt-1', 'PSP fora');
    const sexta = await setup(6).service.markFailed('evt-1', 'PSP fora');

    expect(quinta.status).toBe('failed');
    expect(quinta.nextRetryAt).not.toBeNull();
    expect(sexta.status).toBe('exhausted');
    expect(sexta.nextRetryAt).toBeNull();
  });

  it('se a leitura falha, nada é gravado e o erro sobe', async () => {
    const leitura = jest.fn().mockRejectedValue(new Error('banco fora'));
    const { service, prisma, metrics } = setup(1, leitura);

    await expect(service.markFailed('evt-1', 'PSP fora')).rejects.toThrow('banco fora');
    expect(prisma.paymentWebhookEvent.update).not.toHaveBeenCalled();
    // Métrica só depois de gravar: senão ela divergiria do banco.
    expect(metrics.observePaymentWebhook).not.toHaveBeenCalled();
  });

  it('conta na métrica o estado que de fato ficou gravado', async () => {
    const reagendado = setup(1);
    await reagendado.service.markFailed('evt-1', 'x');
    expect(reagendado.metrics.observePaymentWebhook).toHaveBeenCalledWith('failed');

    const esgotado = setup(6);
    await esgotado.service.markFailed('evt-1', 'x');
    expect(esgotado.metrics.observePaymentWebhook).toHaveBeenCalledWith('exhausted');
  });
});
