import { timingSafeEqual } from 'node:crypto';

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { OPS_SESSION_COOKIE } from '../../ops/ops.constants';
import { CSRF_COOKIE, CSRF_HEADER } from '../csrf.util';
import { isAllowedWebOrigin } from '../http-origin.util';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cookies que caracterizam uma sessão. **Toda** sessão em cookie precisa constar
 * aqui: o guard libera requisições sem sessão (não há o que forjar), então um
 * cookie de sessão ausente desta lista significa mutações passando sem
 * verificação de CSRF. Foi o que quase aconteceu ao introduzir `ops_session`.
 */
const SESSION_COOKIES = ['access_token', 'refresh_token', OPS_SESSION_COOKIE];
/**
 * Rotas que **criam** sessão, e por isso não têm o que proteger: antes delas não
 * há sessão a sequestrar. A isenção vale mesmo quando o navegador ainda envia um
 * cookie antigo, que não pode impedir alguém de entrar de novo.
 *
 * `/auth/logout` e `/auth/refresh` ficam **fora** de propósito: elas agem sobre
 * uma sessão que já existe. Isentas, uma página de terceiro conseguia forçar
 * logout ou rotação de token com um POST cross-site. Continuam funcionando para
 * sessões anteriores ao cookie CSRF porque o guard aceita origem web permitida
 * quando falta o token — e o navegador sempre envia `Origin` num POST
 * cross-origin.
 */
const AUTH_CSRF_EXEMPT_PATHS = new Set(['/auth/login', '/auth/register']);

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
    const hasSession = SESSION_COOKIES.some((name) => Boolean(cookies[name]));
    if (!hasSession) return true;

    const cookieToken = cookies[CSRF_COOKIE];
    const headerToken = request.headers[CSRF_HEADER];

    if (
      cookieToken &&
      typeof headerToken === 'string' &&
      this.safeEqual(headerToken, cookieToken)
    ) {
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
