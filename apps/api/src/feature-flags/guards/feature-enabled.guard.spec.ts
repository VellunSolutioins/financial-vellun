import { FeatureDisabledException } from '../feature-disabled.exception';
import { FeatureEnabledGuard } from './feature-enabled.guard';

const context = { getHandler: () => null, getClass: () => null } as any;

function setup(feature: string | undefined, enabled: boolean) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(feature) } as any;
  const flags = { isEnabled: jest.fn().mockResolvedValue(enabled) } as any;
  return { guard: new FeatureEnabledGuard(reflector, flags), flags };
}

describe('FeatureEnabledGuard', () => {
  it('libera rota sem @RequireFeature sem consultar o banco', async () => {
    const { guard, flags } = setup(undefined, false);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(flags.isEnabled).not.toHaveBeenCalled();
  });

  it('libera quando a funcionalidade está ligada', async () => {
    const { guard, flags } = setup('notes', true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(flags.isEnabled).toHaveBeenCalledWith('notes');
  });

  it('bloqueia com FEATURE_DISABLED quando a funcionalidade está desligada', async () => {
    // É o que impede ler ou gravar dados da funcionalidade chamando a API direto.
    const { guard } = setup('agenda', false);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(FeatureDisabledException);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 403,
      response: { code: 'FEATURE_DISABLED' },
    });
  });
});
