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
