import { SubscriptionStatus } from '@prisma/client';

import { InvalidSubscriptionTransitionError } from '../billing.errors';
import { SubscriptionStateService } from './subscription-state.service';
import { SubscriptionService } from './subscription.service';

function createPrismaMock() {
  return {
    plan: { findMany: jest.fn() },
    subscription: {
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
}

describe('SubscriptionService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: { record: jest.Mock };
  let service: SubscriptionService;

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = { record: jest.fn().mockResolvedValue({}) };
    service = new SubscriptionService(prisma as any, new SubscriptionStateService(), audit as any);
  });

  describe('createSubscription', () => {
    it('calcula trialEndsAt ao iniciar em trialing e audita', async () => {
      prisma.subscription.create.mockImplementation(({ data }: any) => ({ id: 's1', ...data }));

      const result = await service.createSubscription({
        userId: 'u1',
        planId: 'p1',
        status: SubscriptionStatus.trialing,
      });

      const createArg = prisma.subscription.create.mock.calls[0][0];
      expect(createArg.data.trialEndsAt).toBeInstanceOf(Date);
      expect(result.status).toBe('trialing');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'created', newStatus: 'trialing' }),
      );
    });

    it('default status pending sem trial', async () => {
      prisma.subscription.create.mockImplementation(({ data }: any) => ({ id: 's1', ...data }));

      await service.createSubscription({ userId: 'u1', planId: 'p1' });

      const createArg = prisma.subscription.create.mock.calls[0][0];
      expect(createArg.data.status).toBe('pending');
      expect(createArg.data.trialEndsAt).toBeNull();
    });
  });

  describe('transitionTo', () => {
    it('aplica transição válida, atualiza campos e audita', async () => {
      prisma.subscription.findUniqueOrThrow.mockResolvedValue({
        id: 's1',
        status: SubscriptionStatus.active,
      });
      prisma.subscription.update.mockImplementation(({ data }: any) => ({ id: 's1', ...data }));

      const result = await service.transitionTo('s1', SubscriptionStatus.canceled, {
        actor: 'webhook',
        reason: 'cancel_at_period_end',
        data: { cancelAtPeriodEnd: true },
      });

      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { status: 'canceled', cancelAtPeriodEnd: true },
      });
      expect(result.status).toBe('canceled');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'transition:active->canceled',
          previousStatus: 'active',
          newStatus: 'canceled',
          actor: 'webhook',
        }),
      );
    });

    it('rejeita transição inválida sem persistir nem auditar', async () => {
      prisma.subscription.findUniqueOrThrow.mockResolvedValue({
        id: 's1',
        status: SubscriptionStatus.expired,
      });

      await expect(
        service.transitionTo('s1', SubscriptionStatus.past_due, { actor: 'webhook' }),
      ).rejects.toBeInstanceOf(InvalidSubscriptionTransitionError);

      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
