import { ForbiddenException } from '@nestjs/common';

import { CsrfGuard } from './csrf.guard';

function context(
  method: string,
  cookies: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, cookies, headers }) }),
  } as any;
}

describe('CsrfGuard', () => {
  let guard: CsrfGuard;

  beforeEach(() => {
    guard = new CsrfGuard();
  });

  it('libera métodos seguros (GET)', () => {
    expect(guard.canActivate(context('GET'))).toBe(true);
  });

  it('libera requisições sem cookie de sessão (login/cadastro/webhook)', () => {
    expect(guard.canActivate(context('POST'))).toBe(true);
  });

  it('bloqueia mutação com sessão e sem token CSRF', () => {
    expect(() => guard.canActivate(context('POST', { access_token: 'jwt' }))).toThrow(
      ForbiddenException,
    );
  });

  it('bloqueia quando header não bate com o cookie', () => {
    expect(() =>
      guard.canActivate(
        context('POST', { access_token: 'jwt', csrf_token: 'abc' }, { 'x-csrf-token': 'xyz' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('libera quando header CSRF bate com o cookie (double-submit)', () => {
    expect(
      guard.canActivate(
        context('POST', { access_token: 'jwt', csrf_token: 'abc' }, { 'x-csrf-token': 'abc' }),
      ),
    ).toBe(true);
  });

  it('exige CSRF também quando há refresh_token', () => {
    expect(() => guard.canActivate(context('POST', { refresh_token: 'r' }))).toThrow(
      ForbiddenException,
    );
  });
});
