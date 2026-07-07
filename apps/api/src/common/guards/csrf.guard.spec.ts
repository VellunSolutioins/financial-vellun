import { ForbiddenException } from '@nestjs/common';

import { CsrfGuard } from './csrf.guard';

function context(
  method: string,
  cookies: Record<string, string> = {},
  headers: Record<string, string> = {},
  path = '/transactions',
) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, cookies, headers, path }) }),
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

  it('libera login mesmo quando o navegador ainda envia cookie de sessão antigo', () => {
    expect(guard.canActivate(context('POST', { access_token: 'jwt' }, {}, '/auth/login'))).toBe(
      true,
    );
  });

  it('libera refresh para sessões emitidas antes do cookie CSRF existir', () => {
    expect(guard.canActivate(context('POST', { refresh_token: 'r' }, {}, '/auth/refresh'))).toBe(
      true,
    );
  });

  it('bloqueia mutação com sessão e sem token CSRF', () => {
    expect(() => guard.canActivate(context('POST', { access_token: 'jwt' }))).toThrow(
      ForbiddenException,
    );
  });

  it('libera mutação com sessão sem token CSRF quando a origem web é permitida', () => {
    expect(
      guard.canActivate(
        context(
          'POST',
          { access_token: 'jwt', refresh_token: 'r' },
          { origin: 'https://financial-vellun-web.vercel.app' },
          '/billing/checkout',
        ),
      ),
    ).toBe(true);
  });

  it('libera previews da Vercel como origem web permitida', () => {
    expect(
      guard.canActivate(
        context(
          'PATCH',
          { access_token: 'jwt' },
          { origin: 'https://financial-vellun-web-git-main-vellun-s-projects.vercel.app' },
        ),
      ),
    ).toBe(true);
  });

  it('bloqueia mutação com sessão sem token CSRF de origem desconhecida', () => {
    expect(() =>
      guard.canActivate(
        context('POST', { access_token: 'jwt' }, { origin: 'https://evil.example' }),
      ),
    ).toThrow(ForbiddenException);
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
