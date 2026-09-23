import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { OPS_SESSION_COOKIE } from '../../ops/ops.constants';
import { safeEqual } from '../crypto.util';
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
 * Rotas que **criam** sessão. Dispensam o token CSRF — antes delas não há sessão
 * a sequestrar, e um cookie antigo não pode impedir alguém de entrar de novo —,
 * mas não a origem: se o navegador informa `Origin`, ela precisa ser permitida.
 * Sem isso, uma página de terceiro fazia *login CSRF*, entrando o visitante na
 * conta do atacante para que ele registrasse ali seus dados. Chamada sem
 * `Origin` (cliente fora do navegador) continua aceita: o ataque depende do
 * navegador, que sempre envia `Origin` num POST cross-origin.
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
    if (this.isAuthCsrfExemptPath(request)) {
      if (request.headers.origin === undefined || this.hasAllowedOrigin(request)) return true;
      throw this.csrfFailed();
    }

    const cookies = (request.cookies ?? {}) as Record<string, string | undefined>;
    const hasSession = SESSION_COOKIES.some((name) => Boolean(cookies[name]));
    if (!hasSession) return true;

    const cookieToken = cookies[CSRF_COOKIE];
    const headerToken = request.headers[CSRF_HEADER];

    if (cookieToken && typeof headerToken === 'string' && safeEqual(headerToken, cookieToken)) {
      return true;
    }

    if (this.hasAllowedOrigin(request)) {
      return true;
    }

    throw this.csrfFailed();
  }

  private csrfFailed(): ForbiddenException {
    return new ForbiddenException({
      statusCode: 403,
      code: 'CSRF_FAILED',
      message: 'Falha na validação CSRF.',
    });
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
