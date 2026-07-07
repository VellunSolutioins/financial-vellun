import { BadRequestException, NotFoundException } from '@nestjs/common';

import { BillingService } from './billing.service';

function setup() {
  const provider = {
    createCustomer: jest.fn(),
    createCheckout: jest.fn(),
    createPaymentMethodUpdateSession: jest.fn(),
    cancelSubscription: jest.fn(),
  };
  const prisma = {
    plan: { findUnique: jest.fn() },
    user: { findUniqueOrThrow: jest.fn() },
  };
  const subscriptions = {
    getActivePlans: jest.fn(),
    getUserSubscription: jest.fn(),
    prepareCheckoutSubscription: jest.fn(),
    scheduleCancellation: jest.fn(),
  };
  const access = { evaluate: jest.fn() };
  const config = { get: jest.fn(() => 'http://localhost:3000') };

  const service = new BillingService(
    provider as any,
    prisma as any,
    subscriptions as any,
    access as any,
    config as any,
  );
  return { service, provider, prisma, subscriptions, access };
}

const PLAN = {
  id: 'plan_1',
  code: 'vellun-mensal',
  isActive: true,
  interval: 'monthly',
  price: { toString: () => '49.90' },
  currency: 'BRL',
};

describe('BillingService.createCheckout', () => {
  it('cria cliente e checkout sem ativar a assinatura', async () => {
    const { service, provider, prisma, subscriptions, access } = setup();
    prisma.plan.findUnique.mockResolvedValue(PLAN);
    subscriptions.getUserSubscription.mockResolvedValue(null);
    access.evaluate.mockReturnValue({ allowed: false });
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'u1',
      name: 'Fulano',
      email: 'f@x.com',
      phone: '(41) 99999-9999',
      postalCode: '80240-000',
      street: 'Rua das Flores',
      addressNumber: '123',
      complement: null,
      neighborhood: 'Centro',
      city: 'Curitiba',
      state: 'PR',
      individualProfile: { cpf: '111' },
      businessProfile: null,
    });
    provider.createCustomer.mockResolvedValue({ id: 'cus_1' });
    provider.createCheckout.mockResolvedValue({ checkoutUrl: 'https://asaas/checkout/1' });

    const result = await service.createCheckout('u1', { planId: 'plan_1' });

    expect(provider.createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        document: '111',
        postalCode: '80240-000',
        street: 'Rua das Flores',
        addressNumber: '123',
        neighborhood: 'Centro',
      }),
    );
    expect(provider.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ planCode: 'vellun-mensal', providerCustomerId: 'cus_1' }),
    );
    expect(subscriptions.prepareCheckoutSubscription).toHaveBeenCalledWith('u1', 'plan_1', 'cus_1');
    expect(result).toEqual({ checkoutUrl: 'https://asaas/checkout/1' });
  });

  it('reusa providerCustomerId existente', async () => {
    const { service, provider, prisma, subscriptions, access } = setup();
    prisma.plan.findUnique.mockResolvedValue(PLAN);
    subscriptions.getUserSubscription.mockResolvedValue({
      providerCustomerId: 'cus_existing',
      status: 'canceled',
    });
    access.evaluate.mockReturnValue({ allowed: false });
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'u1',
      name: 'Fulano',
      email: 'f@x.com',
      phone: null,
      individualProfile: null,
      businessProfile: { cnpj: '222' },
    });
    provider.createCheckout.mockResolvedValue({ checkoutUrl: 'https://asaas/checkout/2' });

    await service.createCheckout('u1', { planId: 'plan_1' });

    expect(provider.createCustomer).not.toHaveBeenCalled();
    expect(provider.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ providerCustomerId: 'cus_existing' }),
    );
  });

  it('rejeita quando o endereço de cobrança está incompleto', async () => {
    const { service, provider, prisma, subscriptions, access } = setup();
    prisma.plan.findUnique.mockResolvedValue(PLAN);
    subscriptions.getUserSubscription.mockResolvedValue(null);
    access.evaluate.mockReturnValue({ allowed: false });
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'u1',
      name: 'Fulano',
      email: 'f@x.com',
      phone: '(41) 99999-9999',
      postalCode: null,
      street: null,
      addressNumber: null,
      complement: null,
      neighborhood: null,
      city: null,
      state: null,
      individualProfile: { cpf: '111' },
      businessProfile: null,
    });

    await expect(service.createCheckout('u1', { planId: 'plan_1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(provider.createCustomer).not.toHaveBeenCalled();
  });

  it('rejeita quando já há assinatura ativa', async () => {
    const { service, prisma, subscriptions, access } = setup();
    prisma.plan.findUnique.mockResolvedValue(PLAN);
    subscriptions.getUserSubscription.mockResolvedValue({ status: 'active' });
    access.evaluate.mockReturnValue({ allowed: true });

    await expect(service.createCheckout('u1', { planId: 'plan_1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejeita plano inexistente', async () => {
    const { service, prisma } = setup();
    prisma.plan.findUnique.mockResolvedValue(null);

    await expect(service.createCheckout('u1', { planId: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('BillingService.cancel', () => {
  it('cancela no Asaas e agenda cancelamento ao fim do período', async () => {
    const { service, provider, subscriptions, access } = setup();
    subscriptions.getUserSubscription
      .mockResolvedValueOnce({ id: 's1', providerSubscriptionId: 'sub_1' })
      .mockResolvedValueOnce(null);
    access.evaluate.mockReturnValue({ allowed: false, reason: 'no_subscription' });

    await service.cancel('u1');

    expect(provider.cancelSubscription).toHaveBeenCalledWith({
      providerSubscriptionId: 'sub_1',
      cancelAtPeriodEnd: true,
    });
    expect(subscriptions.scheduleCancellation).toHaveBeenCalledWith('s1', 'user');
  });

  it('lança quando não há assinatura', async () => {
    const { service, subscriptions } = setup();
    subscriptions.getUserSubscription.mockResolvedValue(null);

    await expect(service.cancel('u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
