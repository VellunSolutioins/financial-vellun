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

  it('libera cadastro mesmo quando o navegador ainda envia cookie de sessão antigo', () => {
    expect(guard.canActivate(context('POST', { refresh_token: 'r' }, {}, '/auth/register'))).toBe(
      true,
    );
  });

  // ── Logout e refresh ─────────────────────────────────────────────────────
  // Eram isentos de CSRF por inteiro. Como agem sobre uma sessão que já existe,
  // uma página de terceiro conseguia forçar logout ou rotação de token com um
  // POST cross-site, sem token e sem checagem de origem.
  it.each(['/auth/logout', '/auth/refresh'])(
    'bloqueia %s cross-site, sem token CSRF e de origem desconhecida',
    (path) => {
      expect(() =>
        guard.canActivate(
          context(
            'POST',
            { access_token: 'jwt', refresh_token: 'r' },
            { origin: 'https://evil.example' },
            path,
          ),
        ),
      ).toThrow(ForbiddenException);
    },
  );

  it.each(['/auth/logout', '/auth/refresh'])(
    'bloqueia %s sem token CSRF e sem cabeçalho Origin',
    (path) => {
      expect(() => guard.canActivate(context('POST', { refresh_token: 'r' }, {}, path))).toThrow(
        ForbiddenException,
      );
    },
  );

  it.each(['/auth/logout', '/auth/refresh'])(
    'libera %s da origem web para sessões emitidas antes do cookie CSRF existir',
    (path) => {
      // O motivo original da isenção continua coberto: sem `csrf_token`, o
      // navegador do app envia `Origin` num POST cross-origin, e a origem é aceita.
      expect(
        guard.canActivate(
          context(
            'POST',
            { refresh_token: 'r' },
            { origin: 'https://financial-vellun-web.vercel.app' },
            path,
          ),
        ),
      ).toBe(true);
    },
  );

  it.each(['/auth/logout', '/auth/refresh'])('libera %s com double-submit válido', (path) => {
    expect(
      guard.canActivate(
        context('POST', { refresh_token: 'r', csrf_token: 'abc' }, { 'x-csrf-token': 'abc' }, path),
      ),
    ).toBe(true);
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

  // ── Sessão de operações ────────────────────────────────────────────────────
  // O guard libera requisições sem cookie de sessão. Enquanto `ops_session` não
  // contava como sessão, todo POST da área de operações — reprocessar mensagem,
  // descartar item, promover operador — passava sem verificação de CSRF.
  it('exige CSRF quando a sessão é a de operações', () => {
    expect(() =>
      guard.canActivate(context('POST', { ops_session: 'jwt' }, {}, '/ops/failures/1/reprocess')),
    ).toThrow(ForbiddenException);
  });

  it('libera a sessão de operações com double-submit válido', () => {
    expect(
      guard.canActivate(
        context(
          'POST',
          { ops_session: 'jwt', csrf_token: 'abc' },
          { 'x-csrf-token': 'abc' },
          '/ops/failures/1/reprocess',
        ),
      ),
    ).toBe(true);
  });

  it('bloqueia a sessão de operações vinda de origem desconhecida', () => {
    expect(() =>
      guard.canActivate(
        context(
          'POST',
          { ops_session: 'jwt' },
          { origin: 'https://evil.example' },
          '/ops/auth/logout',
        ),
      ),
    ).toThrow(ForbiddenException);
  });

  it('não confunde a rota de login do produto com a área de operações', () => {
    // `/auth/login` é isento de CSRF; `/ops/auth/...` nunca herda essa isenção.
    expect(() =>
      guard.canActivate(context('POST', { ops_session: 'jwt' }, {}, '/ops/auth/logout')),
    ).toThrow(ForbiddenException);
  });
});
