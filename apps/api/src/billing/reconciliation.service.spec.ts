import { ChargeSyncService } from './services/charge-sync.service';
import { SubscriptionStateService } from './services/subscription-state.service';
import { ReconciliationService } from './reconciliation.service';

/** "Agora" dos testes: 12/10/2026, meio-dia em Brasília. */
const NOW = new Date('2026-10-12T15:00:00Z');

function setup() {
  const provider = {
    getSubscription: jest.fn().mockResolvedValue({ status: 'active' }),
    listSubscriptionPayments: jest.fn().mockResolvedValue([]),
    cancelSubscription: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    subscription: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const subscriptions = { transitionTo: jest.fn().mockResolvedValue({}) };
  const payments = {
    findByProviderId: jest.fn().mockResolvedValue(null),
    hasNewerDecisiveCharge: jest.fn().mockResolvedValue(false),
    hasOpenChargeback: jest.fn().mockResolvedValue(false),
    upsertFromProvider: jest.fn().mockResolvedValue({}),
  };
  const state = new SubscriptionStateService();

  // Sincronização real: é a regra de efeito da cobrança que impede a
  // reconciliação de reativar inadimplente.
  const charges = new ChargeSyncService(
    provider as any,
    subscriptions as any,
    state,
    payments as any,
  );
  const service = new ReconciliationService(
    provider as any,
    prisma as any,
    subscriptions as any,
    state,
    charges,
  );

  /** Reconcilia uma assinatura cujo estado local, relido do banco, é `local`. */
  const reconcileOne = (local: ReturnType<typeof localSub>) => {
    prisma.subscription.findUnique.mockResolvedValue(local);
    return service.reconcileSubscription(local);
  };

  return { service, provider, prisma, subscriptions, payments, reconcileOne };
}

function localSub(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    userId: 'u1',
    status: 'active',
    providerSubscriptionId: 'sub_a',
    currentPeriodEnd: new Date('2026-10-15T12:00:00Z'),
    cancelAtPeriodEnd: false,
    plan: { interval: 'monthly' },
    ...overrides,
  } as any;
}

function charge(id: string, status: string, dueDate: string) {
  return {
    id,
    status,
    amount: '49.90',
    currency: 'BRL',
    dueAt: new Date(`${dueDate}T12:00:00Z`),
    paidAt: status === 'paid' ? new Date(`${dueDate}T12:00:00Z`) : null,
    providerSubscriptionId: 'sub_a',
    providerCustomerId: 'cus_a',
    providerCheckoutId: null,
  };
}

/**
 * Como o Asaas devolve: da mais nova para a mais antiga, com as cobranças
 * futuras (já geradas, ainda `pending`) no topo.
 */
const FUTURE = [
  charge('pay_dez', 'pending', '2026-11-15'),
  charge('pay_nov', 'pending', '2026-10-15'),
];

describe('ReconciliationService.reconcileSubscription', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  describe('assinatura ativa no PSP: quem decide são as cobranças', () => {
    it('é consistente quando a última cobrança vencida está paga e o período local confere', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        ...FUTURE,
        charge('pay_set', 'paid', '2026-09-15'),
      ]);

      expect(await reconcileOne(localSub())).toBe('consistent');
      expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    });

    it('NÃO promove inadimplente: local past_due + remoto active + última cobrança vencida', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        ...FUTURE,
        charge('pay_set', 'failed', '2026-09-15'),
        charge('pay_ago', 'paid', '2026-08-15'),
      ]);

      expect(await reconcileOne(localSub({ status: 'past_due' }))).toBe('consistent');
      expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    });

    it('NÃO promove chargeback: local unpaid + remoto active', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        ...FUTURE,
        charge('pay_set', 'chargeback', '2026-09-15'),
      ]);

      expect(await reconcileOne(localSub({ status: 'unpaid' }))).toBe('consistent');
      expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    });

    it('chargeback de cobrança antiga decide, mesmo com as seguintes pagas', async () => {
      const { provider, subscriptions, payments, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        ...FUTURE,
        charge('pay_set', 'paid', '2026-09-15'),
        charge('pay_ago', 'chargeback', '2026-08-15'),
      ]);
      // A cobrança de setembro, paga e mais nova, já está registrada.
      payments.hasNewerDecisiveCharge.mockResolvedValue(true);

      expect(await reconcileOne(localSub({ status: 'active' }))).toBe('corrected');
      expect(subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'unpaid',
        expect.objectContaining({ actor: 'reconciliation' }),
      );
      expect(payments.upsertFromProvider).toHaveBeenCalledWith(
        expect.objectContaining({ providerPaymentId: 'pay_ago', status: 'chargeback' }),
      );
    });

    it('não devolve o acesso a quem está unpaid enquanto houver cobrança em disputa', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        charge('pay_out', 'paid', '2026-10-10'),
        charge('pay_ago', 'chargeback', '2026-08-15'),
      ]);

      expect(await reconcileOne(localSub({ status: 'unpaid' }))).toBe('consistent');
      expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    });

    it('rebaixa quem está active com a última cobrança vencida (webhook de vencimento perdido)', async () => {
      const { provider, subscriptions, payments, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        ...FUTURE,
        charge('pay_set', 'failed', '2026-09-15'),
      ]);

      expect(await reconcileOne(localSub({ status: 'active' }))).toBe('corrected');
      expect(subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'past_due',
        expect.objectContaining({
          actor: 'reconciliation',
          data: expect.objectContaining({ graceUntil: new Date('2026-09-18T12:00:00Z') }),
        }),
      );
      expect(payments.upsertFromProvider).toHaveBeenCalledWith(
        expect.objectContaining({ providerPaymentId: 'pay_set', status: 'failed' }),
      );
    });

    it('rebaixa mesmo com a cobrança já registrada como vencida (estado deixado pelo bug antigo)', async () => {
      const { provider, subscriptions, payments, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        charge('pay_set', 'failed', '2026-09-15'),
      ]);
      payments.findByProviderId.mockResolvedValue({ status: 'failed', failedAt: new Date() });

      expect(await reconcileOne(localSub({ status: 'active' }))).toBe('corrected');
      expect(subscriptions.transitionTo).toHaveBeenCalledWith('s1', 'past_due', expect.anything());
    });

    it('ativa quem pagou e ficou pending (webhook de pagamento perdido)', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        charge('pay_out', 'paid', '2026-10-10'),
      ]);

      const outcome = await reconcileOne(localSub({ status: 'pending', currentPeriodEnd: null }));

      expect(outcome).toBe('corrected');
      expect(subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'active',
        expect.objectContaining({
          actor: 'reconciliation',
          data: expect.objectContaining({
            currentPeriodStart: new Date('2026-10-10T12:00:00Z'),
            currentPeriodEnd: new Date('2026-11-10T12:00:00Z'),
          }),
        }),
      );
    });

    it('corrige o fim do período quando difere do derivado da cobrança paga', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        ...FUTURE,
        charge('pay_set', 'paid', '2026-09-15'),
      ]);

      // Valor antigo: vinha do `nextDueDate` do PSP, um ciclo à frente.
      const outcome = await reconcileOne(
        localSub({ currentPeriodEnd: new Date('2026-11-15T12:00:00Z') }),
      );

      expect(outcome).toBe('corrected');
      expect(subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'active',
        expect.objectContaining({
          data: expect.objectContaining({ currentPeriodEnd: new Date('2026-10-15T12:00:00Z') }),
        }),
      );
    });

    it('não decide nada enquanto a cobrança que venceu hoje ainda está pendente', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        charge('pay_hoje', 'pending', '2026-10-12'),
        charge('pay_set', 'failed', '2026-09-12'),
      ]);

      expect(await reconcileOne(localSub({ status: 'active' }))).toBe('consistent');
      expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    });

    it('ignora cobranças futuras e removidas ao escolher a que decide', async () => {
      const { provider, payments, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        ...FUTURE,
        charge('pay_removida', 'canceled', '2026-10-01'),
        charge('pay_set', 'paid', '2026-09-15'),
      ]);

      await reconcileOne(localSub());

      expect(payments.upsertFromProvider).toHaveBeenCalledTimes(1);
      expect(payments.upsertFromProvider).toHaveBeenCalledWith(
        expect.objectContaining({ providerPaymentId: 'pay_set' }),
      );
    });

    it('é consistente quando ainda não há cobrança vencida', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue(FUTURE);

      expect(await reconcileOne(localSub())).toBe('consistent');
      expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    });

    it('decide com o estado local relido depois das consultas ao PSP, não com o do início do lote', async () => {
      const { service, provider, prisma, subscriptions } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        charge('pay_set', 'failed', '2026-09-15'),
      ]);
      // No início do lote estava `active`; um webhook já a levou a `past_due`.
      prisma.subscription.findUnique.mockResolvedValue(localSub({ status: 'past_due' }));

      const outcome = await service.reconcileSubscription(localSub({ status: 'active' }));

      expect(outcome).toBe('consistent');
      expect(subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(provider.listSubscriptionPayments.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.subscription.findUnique.mock.invocationCallOrder[0],
      );
    });
  });

  describe('cobrança estornada: a reconciliação não cancela sozinha', () => {
    const refunded = [...FUTURE, charge('pay_set', 'refunded', '2026-09-15')];

    it('avisa e deixa a assinatura como está, sem tocar no PSP', async () => {
      const { provider, subscriptions, payments, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue(refunded);

      expect(await reconcileOne(localSub({ status: 'active' }))).toBe('divergent');
      expect(provider.cancelSubscription).not.toHaveBeenCalled();
      expect(subscriptions.transitionTo).not.toHaveBeenCalled();
      expect(payments.upsertFromProvider).toHaveBeenCalledWith(
        expect.objectContaining({ providerPaymentId: 'pay_set', status: 'refunded' }),
      );
    });

    it('avisa uma vez só: com o estorno já registrado, a passada seguinte é consistente', async () => {
      const { provider, subscriptions, payments, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue(refunded);
      payments.findByProviderId.mockResolvedValue({ status: 'refunded' });

      expect(await reconcileOne(localSub({ status: 'active' }))).toBe('consistent');
      expect(provider.cancelSubscription).not.toHaveBeenCalled();
      expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    });
  });

  describe('período pago que terminou sem nova cobrança no PSP', () => {
    it('move para past_due, com grace contado do fim do período', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      // A cobrança de setembro foi removida no painel e nenhuma outra foi gerada.
      provider.listSubscriptionPayments.mockResolvedValue([
        charge('pay_set', 'canceled', '2026-09-15'),
        charge('pay_ago', 'paid', '2026-08-15'),
      ]);

      const outcome = await reconcileOne(
        localSub({ currentPeriodEnd: new Date('2026-09-15T12:00:00Z') }),
      );

      expect(outcome).toBe('corrected');
      expect(subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'past_due',
        expect.objectContaining({
          actor: 'reconciliation',
          data: { graceUntil: new Date('2026-09-18T12:00:00Z') },
        }),
      );
    });

    it('não mexe quando o PSP já gerou a cobrança seguinte', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        charge('pay_nov', 'pending', '2026-10-15'),
        charge('pay_ago', 'paid', '2026-08-15'),
      ]);

      const outcome = await reconcileOne(
        localSub({ currentPeriodEnd: new Date('2026-09-15T12:00:00Z') }),
      );

      expect(outcome).toBe('consistent');
      expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    });

    it('não mexe em quem já está inadimplente', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      provider.listSubscriptionPayments.mockResolvedValue([
        charge('pay_ago', 'paid', '2026-08-15'),
      ]);

      expect(await reconcileOne(localSub({ status: 'past_due' }))).toBe('consistent');
      expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    });
  });

  describe('assinatura encerrada no PSP', () => {
    it('corrige status divergente de forma auditável (remoto canceled)', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      provider.getSubscription.mockResolvedValue({ status: 'canceled' });

      expect(await reconcileOne(localSub({ status: 'active' }))).toBe('corrected');
      expect(subscriptions.transitionTo).toHaveBeenCalledWith(
        's1',
        'canceled',
        expect.objectContaining({ actor: 'reconciliation' }),
      );
      expect(provider.listSubscriptionPayments).not.toHaveBeenCalled();
    });

    it('mantém ativa quando remoto cancelado mas cancelamento ainda adiado (dentro do período)', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      provider.getSubscription.mockResolvedValue({ status: 'canceled' });

      const outcome = await reconcileOne(
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
      const { provider, subscriptions, reconcileOne } = setup();
      provider.getSubscription.mockResolvedValue({ status: 'canceled' });

      const outcome = await reconcileOne(
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

    it('sinaliza divergência não auto-corrigível sem transicionar', async () => {
      const { provider, subscriptions, reconcileOne } = setup();
      // local 'expired', remoto 'canceled': expired→canceled não é transição válida.
      provider.getSubscription.mockResolvedValue({ status: 'canceled' });

      expect(await reconcileOne(localSub({ status: 'expired' }))).toBe('divergent');
      expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    });
  });

  it('ignora status remoto ambíguo (inactive)', async () => {
    const { provider, subscriptions, reconcileOne } = setup();
    provider.getSubscription.mockResolvedValue({ status: 'inactive' });

    expect(await reconcileOne(localSub({ status: 'active' }))).toBe('consistent');
    expect(subscriptions.transitionTo).not.toHaveBeenCalled();
    expect(provider.listSubscriptionPayments).not.toHaveBeenCalled();
  });
});

describe('ReconciliationService.reconcile', () => {
  it('percorre o lote e é resiliente a erro por item', async () => {
    const { service, provider, prisma } = setup();
    prisma.subscription.findMany.mockResolvedValue([
      { id: 's1', providerSubscriptionId: 'sub_a' },
      { id: 's2', providerSubscriptionId: 'sub_b' },
    ]);
    prisma.subscription.findUnique.mockResolvedValue(localSub({ id: 's1' }));
    provider.getSubscription
      .mockResolvedValueOnce({ status: 'canceled' }) // s1 corrigida
      .mockRejectedValueOnce(new Error('PSP indisponível')); // s2 erro

    const summary = await service.reconcile();

    expect(summary).toEqual({ checked: 2, corrected: 1, divergent: 0, errors: 1 });
  });

  it('faz rodízio: ordena pelo cursor e o avança no lote inteiro, inclusive em quem deu erro', async () => {
    const { service, provider, prisma } = setup();
    prisma.subscription.findMany.mockResolvedValue([
      { id: 's1', providerSubscriptionId: 'sub_a' }, // consistente: nada muda nela
      { id: 's2', providerSubscriptionId: 'sub_b' },
    ]);
    prisma.subscription.findUnique.mockResolvedValue(localSub({ id: 's1' }));
    provider.getSubscription
      .mockResolvedValueOnce({ status: 'active' })
      .mockRejectedValueOnce(new Error('PSP indisponível'));

    await service.reconcile();

    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { lastReconciledAt: { sort: 'asc', nulls: 'first' } },
      }),
    );
    expect(prisma.subscription.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1', 's2'] } },
      data: { lastReconciledAt: expect.any(Date) },
    });
  });

  it('falha ao avançar o cursor não derruba a reconciliação', async () => {
    const { service, prisma } = setup();
    prisma.subscription.findMany.mockResolvedValue([{ id: 's1', providerSubscriptionId: 'sub_a' }]);
    prisma.subscription.findUnique.mockResolvedValue(localSub({ id: 's1' }));
    prisma.subscription.updateMany.mockRejectedValue(new Error('banco fora'));

    const summary = await service.reconcile();

    expect(summary).toEqual({ checked: 1, corrected: 0, divergent: 0, errors: 0 });
  });

  it('lote vazio não escreve nada', async () => {
    const { service, prisma } = setup();
    prisma.subscription.findMany.mockResolvedValue([]);

    await service.reconcile();

    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
  });
});
