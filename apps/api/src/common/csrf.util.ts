import { randomBytes } from 'node:crypto';

import { CookieOptions, Response } from 'express';

export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Emite o token CSRF como cookie **legível por JS** (não HttpOnly) para o
 * esquema double-submit: o frontend lê o cookie e ecoa no header
 * `x-csrf-token`; o {@link CsrfGuard} compara os dois.
 */
export function issueCsrfCookie(res: Response, baseOptions: CookieOptions): void {
  const token = randomBytes(32).toString('hex');
  res.cookie(CSRF_COOKIE, token, {
    ...baseOptions,
    httpOnly: false,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}
