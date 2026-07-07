import { UnauthorizedException } from '@nestjs/common';

import { InternalApiKeyGuard } from './internal-api-key.guard';

const KEY = 'super-secret-internal-key';

function context(provided?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { 'x-internal-api-key': provided } }),
    }),
  } as any;
}

describe('InternalApiKeyGuard', () => {
  let guard: InternalApiKeyGuard;

  beforeEach(() => {
    const config = { getOrThrow: jest.fn().mockReturnValue(KEY) } as any;
    guard = new InternalApiKeyGuard(config);
  });

  it('libera com a chave correta', () => {
    expect(guard.canActivate(context(KEY))).toBe(true);
  });

  it('rejeita chave incorreta', () => {
    expect(() => guard.canActivate(context('wrong'))).toThrow(UnauthorizedException);
  });

  it('rejeita ausência de chave', () => {
    expect(() => guard.canActivate(context(undefined))).toThrow(UnauthorizedException);
  });
});
