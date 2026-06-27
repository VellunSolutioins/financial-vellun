import { SubscriptionStatus } from '@prisma/client';

import { SubscriptionAccessService } from './subscription-access.service';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const FUTURE = new Date('2026-06-20T12:00:00.000Z');
const PAST = new Date('2026-06-10T12:00:00.000Z');

function makeService(findFirst: jest.Mock) {
  const prisma = { subscription: { findFirst } } as any;
  return new SubscriptionAccessService(prisma);
}

describe('SubscriptionAccessService', () => {
  describe('evaluate', () => {
    let service: SubscriptionAccessService;

    beforeEach(() => {
      service = makeService(jest.fn());
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

  describe('canUseProduct', () => {
    it('usa a assinatura mais recente do usuário', async () => {
      const findFirst = jest.fn().mockResolvedValue({
        id: 's1',
        status: SubscriptionStatus.active,
        trialEndsAt: null,
        graceUntil: null,
      });
      const service = makeService(findFirst);

      const result = await service.canUseProduct('u1', NOW);

      expect(findFirst).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result.allowed).toBe(true);
    });

    it('nega quando usuário não tem assinatura', async () => {
      const service = makeService(jest.fn().mockResolvedValue(null));
      const result = await service.canUseProduct('u1', NOW);
      expect(result).toMatchObject({ allowed: false, reason: 'no_subscription' });
    });
  });
});
