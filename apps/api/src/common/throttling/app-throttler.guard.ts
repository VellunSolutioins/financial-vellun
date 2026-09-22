import { createHmac } from 'node:crypto';

import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import { safeEqual } from '../crypto.util';

/** Prefixo das chaves de rate limit no Redis (regra C1). */
export const RATE_LIMIT_KEY_PREFIX = 'rl:';

/**
 * Rate limit por usuário autenticado, e por IP para quem não está logado.
 *
 * Contar só por IP punia todos os usuários atrás do mesmo NAT (escritório,
 * operadora móvel) e deixava um usuário espalhar requisições por vários IPs.
 * O usuário vem do access token **com assinatura verificada**: o guard roda
 * antes da autenticação, e aceitar o `sub` sem verificar deixaria qualquer um
 * trocar de identificador a cada requisição para escapar do limite — ou gastar
 * o limite de outra pessoa.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const userId = verifiedSubject(req.cookies?.access_token, process.env.JWT_SECRET);
    return userId ? `user:${userId}` : `ip:${req.ip}`;
  }

  protected generateKey(context: ExecutionContext, suffix: string, name: string): string {
    return RATE_LIMIT_KEY_PREFIX + super.generateKey(context, suffix, name);
  }
}

/**
 * `sub` de um JWT HS256 válido e não expirado; `null` para qualquer outra
 * coisa. Verificação local e síncrona: não consulta banco nem sessão — só
 * decide qual contador usar, a autenticação de verdade vem depois.
 */
export function verifiedSubject(token: unknown, secret: string | undefined): string | null {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  try {
    const alg = (JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: string }).alg;
    if (alg !== 'HS256') return null;

    const expected = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    if (!safeEqual(signature, expected)) return null;

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null;
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}
