import { ForbiddenException } from '@nestjs/common';

import { SubscriptionRequiredException } from '../subscription-required.exception';
import { ActiveSubscriptionGuard } from './active-subscription.guard';

function context(user: unknown) {
  return {
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
}

function setup(allowWithout: boolean, allowed: boolean, enforced = true) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(allowWithout) } as any;
  const access = {
    canUseProduct: jest.fn().mockResolvedValue({ allowed }),
    isEnforced: jest.fn().mockReturnValue(enforced),
  } as any;
  return { guard: new ActiveSubscriptionGuard(reflector, access), access };
}

describe('ActiveSubscriptionGuard', () => {
  it('libera quando o usuário tem acesso', async () => {
    const { guard } = setup(false, true);
    await expect(guard.canActivate(context({ id: 'u1' }))).resolves.toBe(true);
  });

  it('bloqueia com SUBSCRIPTION_REQUIRED quando sem acesso', async () => {
    const { guard } = setup(false, false);
    await expect(guard.canActivate(context({ id: 'u1' }))).rejects.toBeInstanceOf(
      SubscriptionRequiredException,
    );
  });

  it('libera rota marcada com @AllowWithoutSubscription sem consultar acesso', async () => {
    const { guard, access } = setup(true, false);
    await expect(guard.canActivate(context({ id: 'u1' }))).resolves.toBe(true);
    expect(access.canUseProduct).not.toHaveBeenCalled();
  });

  it('libera todos quando a obrigatoriedade está desligada (rollout)', async () => {
    const { guard, access } = setup(false, false, false);
    await expect(guard.canActivate(context({ id: 'u1' }))).resolves.toBe(true);
    expect(access.canUseProduct).not.toHaveBeenCalled();
  });

  it('rejeita quando não há identidade resolvida', async () => {
    const { guard } = setup(false, true);
    await expect(guard.canActivate(context(undefined))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('expõe o código padrão SUBSCRIPTION_REQUIRED no corpo do 403', () => {
    const response = new SubscriptionRequiredException().getResponse() as any;
    expect(response).toMatchObject({ statusCode: 403, code: 'SUBSCRIPTION_REQUIRED' });
  });
});
