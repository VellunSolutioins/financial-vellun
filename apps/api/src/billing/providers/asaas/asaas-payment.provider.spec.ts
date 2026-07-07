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

describe('AsaasPaymentProvider.today (fuso de cobrança)', () => {
  afterEach(() => jest.useRealTimers());

  it('usa a data no fuso do Brasil, não em UTC (noite no Brasil = dia seguinte em UTC)', () => {
    // 2026-07-01T02:30:00Z = 2026-06-30 23:30 em America/Sao_Paulo (UTC-3).
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T02:30:00Z'));
    const provider = makeProvider() as unknown as { today: () => string };
    expect(provider.today()).toBe('2026-06-30');
  });
});
