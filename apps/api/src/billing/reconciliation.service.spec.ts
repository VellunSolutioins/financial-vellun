import { SubscriptionStateService } from './services/subscription-state.service';
import { ReconciliationService } from './reconciliation.service';

function setup() {
  const provider = { getSubscription: jest.fn() };
  const prisma = {
    subscription: { findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  };
  const subscriptions = { transitionTo: jest.fn().mockResolvedValue({}) };
  const audit = { record: jest.fn().mockResolvedValue({}) };

  const service = new ReconciliationService(
    provider as any,
    prisma as any,
    subscriptions as any,
    audit as any,
    new SubscriptionStateService(),
  );
  return { service, provider, prisma, subscriptions, audit };
}

function localSub(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    status: 'active',
    providerSubscriptionId: 'sub_a',
    currentPeriodEnd: new Date('2026-07-15'),
    ...overrides,
  } as any;
}

describe('ReconciliationService.reconcileSubscription', () => {
  it('é consistente quando local e remoto coincidem', async () => {
    const { service, provider, subscriptions } = setup();
    provider.getSubscription.mockResolvedValue({
      status: 'active',
      currentPeriodEnd: new Date('2026-07-15'),
    });

    const outcome = await service.reconcileSubscription(localSub());

    expect(outcome).toBe('consistent');
    expect(subscriptions.transitionTo).not.toHaveBeenCalled();
  });

  it('corrige status divergente de forma auditável (remoto canceled)', async () => {
    const { service, provider, subscriptions } = setup();
    provider.getSubscription.mockResolvedValue({ status: 'canceled' });

    const outcome = await service.reconcileSubscription(localSub({ status: 'active' }));

    expect(outcome).toBe('corrected');
    expect(subscriptions.transitionTo).toHaveBeenCalledWith(
      's1',
      'canceled',
      expect.objectContaining({ actor: 'reconciliation' }),
    );
  });

  it('mantém ativa quando remoto cancelado mas cancelamento ainda adiado (dentro do período)', async () => {
    const { service, provider, subscriptions } = setup();
    provider.getSubscription.mockResolvedValue({ status: 'canceled' });

    const outcome = await service.reconcileSubscription(
      localSub({
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() + 24 * 60 * 60 * 1000), // amanhã
      }),
    );

    expect(outcome).toBe('consistent');
    expect(subscriptions.transitionTo).not.toHaveBeenCalled();
  });

  it('efetiva o cancelamento quando o período já expirou (remoto cancelado)', async () => {
    const { service, provider, subscriptions } = setup();
    provider.getSubscription.mockResolvedValue({ status: 'canceled' });

    const outcome = await service.reconcileSubscription(
      localSub({
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000), // ontem
      }),
    );

    expect(outcome).toBe('corrected');
    expect(subscriptions.transitionTo).toHaveBeenCalledWith(
      's1',
      'canceled',
      expect.objectContaining({ actor: 'reconciliation' }),
    );
  });

  it('corrige deriva de currentPeriodEnd quando ambos ativos', async () => {
    const { service, provider, prisma, audit } = setup();
    provider.getSubscription.mockResolvedValue({
      status: 'active',
      currentPeriodEnd: new Date('2026-08-15'),
    });

    const outcome = await service.reconcileSubscription(
      localSub({ currentPeriodEnd: new Date('2026-07-15') }),
    );

    expect(outcome).toBe('corrected');
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { currentPeriodEnd: new Date('2026-08-15') },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reconciliation:period_update' }),
    );
  });

  it('sinaliza divergência não auto-corrigível sem transicionar', async () => {
    const { service, provider, subscriptions } = setup();
    // remoto 'active' mas local 'expired' → transição expired→active não é permitida... na verdade é.
    // Use canceled local → active remoto: canceled→active é permitida (recontratação).
    // Para forçar não-corrigível: local 'expired', remoto 'canceled' (expired→canceled inválida).
    provider.getSubscription.mockResolvedValue({ status: 'canceled' });

    const outcome = await service.reconcileSubscription(localSub({ status: 'expired' }));

    expect(outcome).toBe('divergent');
    expect(subscriptions.transitionTo).not.toHaveBeenCalled();
  });

  it('ignora status remoto ambíguo (inactive)', async () => {
    const { service, provider, subscriptions } = setup();
    provider.getSubscription.mockResolvedValue({ status: 'inactive' });

    const outcome = await service.reconcileSubscription(localSub({ status: 'active' }));

    expect(outcome).toBe('consistent');
    expect(subscriptions.transitionTo).not.toHaveBeenCalled();
  });
});

describe('ReconciliationService.reconcile', () => {
  it('percorre o lote e é resiliente a erro por item', async () => {
    const { service, provider, prisma } = setup();
    prisma.subscription.findMany.mockResolvedValue([
      localSub({ id: 's1', status: 'active' }),
      localSub({ id: 's2', status: 'active' }),
    ]);
    provider.getSubscription
      .mockResolvedValueOnce({ status: 'canceled' }) // s1 corrigida
      .mockRejectedValueOnce(new Error('PSP indisponível')); // s2 erro

    const summary = await service.reconcile();

    expect(summary).toEqual({ checked: 2, corrected: 1, divergent: 0, errors: 1 });
  });
});
