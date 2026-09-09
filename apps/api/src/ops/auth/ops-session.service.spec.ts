import { JwtService } from '@nestjs/jwt';

import { OpsSessionService } from './ops-session.service';

const OPS_SECRET = 'ops-secret-com-pelo-menos-32-caracteres!';
const PRODUCT_SECRET = 'produto-secret-com-pelo-menos-32-caracteres!';

function setup(secrets: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    OPS_JWT_SECRET: OPS_SECRET,
    JWT_SECRET: PRODUCT_SECRET,
    ...secrets,
  };
  const config = {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (!value) throw new Error(`${key} ausente`);
      return value;
    },
  } as any;

  const jwt = new JwtService();
  return { service: new OpsSessionService(jwt, config), jwt };
}

const payload = { sub: 'op-1', login: 'alguem', role: 'operator' as const, cvs: false };

describe('OpsSessionService', () => {
  it('assina e verifica a própria sessão', async () => {
    const { service } = setup();
    const token = await service.sign(payload);

    await expect(service.verify(token)).resolves.toMatchObject({
      sub: 'op-1',
      login: 'alguem',
      role: 'operator',
      typ: 'ops',
    });
  });

  it('recusa um token do produto assinado com o segredo do produto', async () => {
    const { service, jwt } = setup();
    // Exatamente o que o AuthService do produto emite.
    const productToken = await jwt.signAsync(
      { sub: 'user-1', email: 'cliente@example.com' },
      { secret: PRODUCT_SECRET, expiresIn: 900 },
    );

    await expect(service.verify(productToken)).resolves.toBeNull();
  });

  it('recusa token assinado com o segredo de ops mas sem `typ: ops`', async () => {
    // Segunda trava: mesmo com o segredo correto, o payload precisa se declarar.
    const { service, jwt } = setup();
    const forjado = await jwt.signAsync(
      { sub: 'user-1', email: 'cliente@example.com' },
      { secret: OPS_SECRET, expiresIn: 900 },
    );

    await expect(service.verify(forjado)).resolves.toBeNull();
  });

  it('recusa token expirado', async () => {
    const { service, jwt } = setup();
    const expirado = await jwt.signAsync(
      { ...payload, typ: 'ops' },
      { secret: OPS_SECRET, expiresIn: -10 },
    );

    await expect(service.verify(expirado)).resolves.toBeNull();
  });

  it('falha alto quando OPS_JWT_SECRET é igual ao JWT_SECRET', async () => {
    // Erro de configuração fácil de cometer, e que degradaria a separação de
    // identidades para uma única checagem de claim.
    const { service } = setup({ OPS_JWT_SECRET: PRODUCT_SECRET });

    await expect(service.sign(payload)).rejects.toThrow(/diferente de JWT_SECRET/);
  });
});
