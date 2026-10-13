import { randomUUID } from 'node:crypto';

import {
  InternalServerErrorException,
  NotImplementedException,
  UnauthorizedException,
} from '@nestjs/common';

import { AsaasPaymentProvider } from './asaas-payment.provider';

const WEBHOOK_TOKEN = 'super-secret-webhook-token';

function makeProvider(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    ASAAS_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
    ...overrides,
  };
  const config = { get: jest.fn((key: string) => values[key]) } as any;
  return new AsaasPaymentProvider(config);
}

const eventBody = JSON.stringify({
  id: 'evt_123',
  event: 'PAYMENT_RECEIVED',
  payment: { id: 'pay_1', status: 'RECEIVED', value: 49.9 },
});

describe('AsaasPaymentProvider.verifyWebhook', () => {
  it('aceita token válido no header e extrai evento', async () => {
    const provider = makeProvider();
    const result = await provider.verifyWebhook({
      rawBody: eventBody,
      headers: { 'asaas-access-token': WEBHOOK_TOKEN },
    });
    expect(result).toEqual({
      providerEventId: 'evt_123',
      eventType: 'PAYMENT_RECEIVED',
      payload: expect.objectContaining({ id: 'evt_123', event: 'PAYMENT_RECEIVED' }),
    });
  });

  it('aceita token válido via signature e corpo em Buffer', async () => {
    const provider = makeProvider();
    const result = await provider.verifyWebhook({
      rawBody: Buffer.from(eventBody),
      signature: WEBHOOK_TOKEN,
    });
    expect(result.providerEventId).toBe('evt_123');
  });

  it('rejeita token inválido', async () => {
    const provider = makeProvider();
    await expect(
      provider.verifyWebhook({ rawBody: eventBody, headers: { 'asaas-access-token': 'wrong' } }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejeita quando token não é configurado', async () => {
    const provider = makeProvider({ ASAAS_WEBHOOK_TOKEN: undefined });
    await expect(
      provider.verifyWebhook({ rawBody: eventBody, signature: WEBHOOK_TOKEN }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('rejeita corpo que não é JSON', async () => {
    const provider = makeProvider();
    await expect(
      provider.verifyWebhook({
        rawBody: 'não-json',
        headers: { 'asaas-access-token': WEBHOOK_TOKEN },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejeita payload sem id/event', async () => {
    const provider = makeProvider();
    await expect(
      provider.verifyWebhook({
        rawBody: JSON.stringify({ foo: 'bar' }),
        headers: { 'asaas-access-token': WEBHOOK_TOKEN },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AsaasPaymentProvider — configuração e stubs', () => {
  it('createPaymentMethodUpdateSession sinaliza pendência (Prompt 0)', async () => {
    const provider = makeProvider();
    await expect(
      provider.createPaymentMethodUpdateSession({
        providerCustomerId: 'cus_1',
        providerSubscriptionId: 'sub_1',
        returnUrl: 'https://app/return',
      }),
    ).rejects.toBeInstanceOf(NotImplementedException);
  });

  it('chamadas HTTP falham com erro claro quando credenciais ausentes', async () => {
    const provider = makeProvider({ ASAAS_API_URL: undefined, ASAAS_API_KEY: undefined });
    await expect(provider.getSubscription('sub_1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('AsaasPaymentProvider — chamadas ao Asaas', () => {
  // Valor qualquer, gerado na hora: o cliente HTTP só o repassa no header.
  const API = { ASAAS_API_URL: 'https://asaas.test/v3', ASAAS_API_KEY: randomUUID() };

  function mockFetch(status: number, body: unknown) {
    return jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(body), { status }));
  }

  afterEach(() => jest.restoreAllMocks());

  it('getPayment consulta a cobrança e devolve o estado e os vínculos dela', async () => {
    const fetchMock = mockFetch(200, {
      id: 'pay_1',
      status: 'OVERDUE',
      value: 49.9,
      dueDate: '2026-09-15',
      subscription: 'sub_1',
      customer: 'cus_1',
      checkoutSession: 'chk_1',
    });

    const result = await makeProvider(API).getPayment('pay_1');

    expect(fetchMock.mock.calls[0][0]).toBe('https://asaas.test/v3/payments/pay_1');
    expect(result).toMatchObject({
      id: 'pay_1',
      status: 'failed',
      providerSubscriptionId: 'sub_1',
      providerCustomerId: 'cus_1',
      providerCheckoutId: 'chk_1',
    });
  });

  it('listSubscriptionPayments pede mais que a página padrão de 10', async () => {
    const fetchMock = mockFetch(200, { data: [{ id: 'pay_1', status: 'PENDING', value: 49.9 }] });

    const result = await makeProvider(API).listSubscriptionPayments('sub_1');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://asaas.test/v3/subscriptions/sub_1/payments?limit=20',
    );
    expect(result).toHaveLength(1);
  });

  it('cancelSubscription trata assinatura já removida (404) como sucesso', async () => {
    mockFetch(404, { errors: [{ description: 'Assinatura não encontrada' }] });

    await expect(
      makeProvider(API).cancelSubscription({
        providerSubscriptionId: 'sub_1',
        cancelAtPeriodEnd: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('cancelSubscription propaga os demais erros', async () => {
    mockFetch(500, { errors: [{ description: 'erro interno' }] });

    await expect(
      makeProvider(API).cancelSubscription({
        providerSubscriptionId: 'sub_1',
        cancelAtPeriodEnd: true,
      }),
    ).rejects.toMatchObject({ name: 'AsaasApiError', status: 500 });
  });
});

describe('AsaasPaymentProvider.today (fuso de cobrança)', () => {
  afterEach(() => jest.useRealTimers());

  it('usa a data no fuso do Brasil, não em UTC (noite no Brasil = dia seguinte em UTC)', () => {
    // 2026-07-01T02:30:00Z = 2026-06-30 23:30 em America/Sao_Paulo (UTC-3).
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T02:30:00Z'));
    const provider = makeProvider() as unknown as { today: () => string };
    expect(provider.today()).toBe('2026-06-30');
  });
});
