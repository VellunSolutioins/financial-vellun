import { timingSafeEqual } from 'node:crypto';

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { CSRF_COOKIE, CSRF_HEADER } from '../csrf.util';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Proteção CSRF por double-submit. Exigida apenas em requisições que mudam
 * estado (não-safe) e que carregam sessão por cookie. Requisições sem cookie de
 * sessão (login/cadastro, webhook do PSP, chamadas internas por API key) não
 * têm autoridade ambiente e ficam isentas. Relevante sobretudo com
 * `SameSite=None` em produção (doc seção 8.3).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

    const cookies = (request.cookies ?? {}) as Record<string, string | undefined>;
    const hasSession = Boolean(cookies['access_token'] || cookies['refresh_token']);
    if (!hasSession) return true;

    const cookieToken = cookies[CSRF_COOKIE];
    const headerToken = request.headers[CSRF_HEADER];

    if (
      !cookieToken ||
      typeof headerToken !== 'string' ||
      !this.safeEqual(headerToken, cookieToken)
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'CSRF_FAILED',
        message: 'Falha na validação CSRF.',
      });
    }

    return true;
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
