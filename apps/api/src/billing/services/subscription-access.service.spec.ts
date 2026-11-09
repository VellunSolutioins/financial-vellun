import { SubscriptionStatus } from '@prisma/client';

import { SubscriptionAccessService } from './subscription-access.service';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const FUTURE = new Date('2026-06-20T12:00:00.000Z');
const PAST = new Date('2026-06-10T12:00:00.000Z');

/**
 * `rows`: as assinaturas do usuário, da mais nova para a mais antiga. O dublê
 * responde às consultas do serviço a partir delas.
 */
function makeService(rows: jest.Mock | Array<Record<string, unknown>>, enforced = 'true') {
  const all = Array.isArray(rows) ? rows : [];
  const prisma = {
    subscription: {
      findMany: jest.fn(async ({ where }: any) =>
        all.filter((row) => where.status.in.includes(row.status)),
      ),
      findFirst: jest.fn(async () => all[0] ?? null),
      findUnique: jest.fn(async ({ where }: any) => {
        const row = all.find((candidate) => candidate.id === where.id);
        return row ? { ...row, plan: { id: 'plan_1' } } : null;
      }),
    },
  } as any;
  const config = { get: jest.fn((_k: string, d?: string) => enforced ?? d) } as any;
  return new SubscriptionAccessService(prisma, config);
}

describe('SubscriptionAccessService', () => {
  describe('evaluate', () => {
    let service: SubscriptionAccessService;

    beforeEach(() => {
      service = makeService([]);
    });

    it('nega acesso quando não há assinatura', () => {
      expect(service.evaluate(null, NOW)).toEqual({
        allowed: false,
        reason: 'no_subscription',
        status: null,
        subscriptionId: null,
      });
    });

    it('libera quando active', () => {
      const result = service.evaluate(
        { id: 's1', status: SubscriptionStatus.active, trialEndsAt: null, graceUntil: null },
        NOW,
      );
      expect(result).toMatchObject({ allowed: true, reason: 'active', status: 'active' });
    });

    it('libera em trialing com trial válido', () => {
      const result = service.evaluate(
        { id: 's1', status: SubscriptionStatus.trialing, trialEndsAt: FUTURE, graceUntil: null },
        NOW,
      );
      expect(result).toMatchObject({ allowed: true, reason: 'trialing' });
    });

    it('nega em trialing com trial expirado', () => {
      const result = service.evaluate(
        { id: 's1', status: SubscriptionStatus.trialing, trialEndsAt: PAST, graceUntil: null },
        NOW,
      );
      expect(result).toMatchObject({ allowed: false, reason: 'trial_expired' });
    });

    it('libera em past_due dentro do grace period', () => {
      const result = service.evaluate(
        { id: 's1', status: SubscriptionStatus.past_due, trialEndsAt: null, graceUntil: FUTURE },
        NOW,
      );
      expect(result).toMatchObject({ allowed: true, reason: 'grace_period' });
    });

    it('nega em past_due com grace expirado', () => {
      const result = service.evaluate(
        { id: 's1', status: SubscriptionStatus.past_due, trialEndsAt: null, graceUntil: PAST },
        NOW,
      );
      expect(result).toMatchObject({ allowed: false, reason: 'grace_expired' });
    });

    it('nega em past_due sem graceUntil definido', () => {
      const result = service.evaluate(
        { id: 's1', status: SubscriptionStatus.past_due, trialEndsAt: null, graceUntil: null },
        NOW,
      );
      expect(result).toMatchObject({ allowed: false, reason: 'grace_expired' });
    });

    it.each([
      SubscriptionStatus.pending,
      SubscriptionStatus.canceled,
      SubscriptionStatus.unpaid,
      SubscriptionStatus.expired,
    ])('nega acesso em status %s', (status) => {
      const result = service.evaluate(
        { id: 's1', status, trialEndsAt: null, graceUntil: null },
        NOW,
      );
      expect(result).toMatchObject({ allowed: false, reason: 'inactive' });
    });
  });

  describe('isEnforced (feature flag)', () => {
    it('habilitado por padrão', () => {
      expect(makeService([]).isEnforced()).toBe(true);
    });

    it('desligado quando BILLING_ENFORCEMENT_ENABLED=false', () => {
      expect(makeService([], 'false').isEnforced()).toBe(false);
    });
  });

  describe('canUseProduct / currentSubscription', () => {
    const row = (id: string, status: SubscriptionStatus, extra = {}) => ({
      id,
      status,
      trialEndsAt: null,
      graceUntil: null,
      ...extra,
    });

    it('na checagem de acesso, lê só as que podem dar acesso, sem o plano', async () => {
      const service = makeService([row('s1', SubscriptionStatus.active)]);
      const prisma = (service as any).prisma;

      const result = await service.canUseProduct('u1', NOW);

      expect(prisma.subscription.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', status: { in: ['active', 'trialing', 'past_due'] } },
        orderBy: { createdAt: 'desc' },
      });
      expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
      expect(prisma.subscription.findUnique).not.toHaveBeenCalled();
      expect(result.allowed).toBe(true);
    });

    it('nega quando usuário não tem assinatura', async () => {
      const service = makeService([]);
      const result = await service.canUseProduct('u1', NOW);
      expect(result).toMatchObject({ allowed: false, reason: 'no_subscription' });
    });

    it('checkout de regularização em aberto não tira o acesso de quem está no grace', async () => {
      // A mais nova é a tentativa `pending` do checkout; a anterior ainda dá acesso.
      const service = makeService([
        row('s_nova', SubscriptionStatus.pending),
        row('s_antiga', SubscriptionStatus.past_due, { graceUntil: FUTURE }),
      ]);

      const result = await service.canUseProduct('u1', NOW);

      expect(result).toMatchObject({
        allowed: true,
        reason: 'grace_period',
        subscriptionId: 's_antiga',
      });
    });

    it('sem nenhuma que dê acesso, vale a mais nova de todas', async () => {
      const service = makeService([
        row('s_nova', SubscriptionStatus.expired),
        row('s_antiga', SubscriptionStatus.past_due, { graceUntil: PAST }),
      ]);

      const current = await service.currentSubscription('u1', NOW);

      expect(current).toMatchObject({ id: 's_nova', plan: { id: 'plan_1' } });
      expect((await service.canUseProduct('u1', NOW)).allowed).toBe(false);
    });

    it('entre duas que dão acesso, vale a mais nova', async () => {
      const service = makeService([
        row('s_nova', SubscriptionStatus.active),
        row('s_antiga', SubscriptionStatus.active),
      ]);

      expect((await service.currentSubscription('u1', NOW))?.id).toBe('s_nova');
    });
  });
});
