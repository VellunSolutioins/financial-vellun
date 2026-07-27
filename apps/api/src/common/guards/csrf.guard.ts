import { timingSafeEqual } from 'node:crypto';

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { CSRF_COOKIE, CSRF_HEADER } from '../csrf.util';
import { isAllowedWebOrigin } from '../http-origin.util';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const AUTH_CSRF_EXEMPT_PATHS = new Set([
  '/auth/login',
  '/auth/register',
  '/auth/logout',
  '/auth/refresh',
  // Recuperação de senha: rotas públicas que não usam a sessão em cookie —
  // um cookie antigo no navegador não pode bloquear quem perdeu o acesso.
  '/auth/forgot-password',
  '/auth/reset-password',
]);

/**
 * Proteção CSRF para requisições com sessão em cookie. Usa double-submit quando
 * o frontend consegue ler `csrf_token`; em deploy cross-domain (Vercel + API em
 * outro domínio), aceita mutações apenas vindas de uma origem web permitida.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
    if (this.isAuthCsrfExemptPath(request)) return true;

    const cookies = (request.cookies ?? {}) as Record<string, string | undefined>;
    const hasSession = Boolean(cookies['access_token'] || cookies['refresh_token']);
    if (!hasSession) return true;

    const cookieToken = cookies[CSRF_COOKIE];
    const headerToken = request.headers[CSRF_HEADER];

    if (cookieToken && typeof headerToken === 'string' && this.safeEqual(headerToken, cookieToken)) {
      return true;
    }

    if (this.hasAllowedOrigin(request)) {
      return true;
    }

    throw new ForbiddenException({
      statusCode: 403,
      code: 'CSRF_FAILED',
      message: 'Falha na validação CSRF.',
    });
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  private isAuthCsrfExemptPath(request: Request): boolean {
    const path = request.path ?? request.url?.split('?')[0];
    return Boolean(path && AUTH_CSRF_EXEMPT_PATHS.has(path));
  }

  private hasAllowedOrigin(request: Request): boolean {
    const origin = request.headers.origin;
    return typeof origin === 'string' && isAllowedWebOrigin(origin);
  }
}
