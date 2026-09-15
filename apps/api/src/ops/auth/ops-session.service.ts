import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CookieOptions, Response } from 'express';
import { OpsRole } from '@prisma/client';

import { issueCsrfCookie } from '../../common/csrf.util';
import {
  OPS_OAUTH_STATE_COOKIE,
  OPS_OAUTH_STATE_TTL_SECONDS,
  OPS_SESSION_COOKIE,
  OPS_SESSION_TTL_SECONDS,
  OPS_TOKEN_TYPE,
} from '../ops.constants';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Base dos cookies de operações. `sameSite: none` em produção porque o painel
 * vive na Vercel e a API em outro domínio — sem isso o cookie não é enviado.
 */
const COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  sameSite: isProduction ? 'none' : 'lax',
  secure: isProduction,
  path: '/',
};

/** Payload do token de sessão do operador. */
export interface OpsSessionPayload {
  /** Id em `ops_operators` — nunca um id de `users`. */
  sub: string;
  login: string;
  role: OpsRole;
  /** `canViewSensitive`, abreviado para manter o token pequeno. */
  cvs: boolean;
  /** Marca o token como de operações. Ver {@link OpsSessionService.verify}. */
  typ: typeof OPS_TOKEN_TYPE;
}

/**
 * Emite e verifica a sessão do operador.
 *
 * Duas travas independentes impedem que um token do produto seja aceito aqui:
 * o **segredo** é outro (`OPS_JWT_SECRET`) e o payload precisa declarar
 * `typ: 'ops'`. A segunda existe porque a primeira depende de os dois segredos
 * serem realmente diferentes na configuração — e isso é um erro de operação
 * fácil de cometer.
 */
@Injectable()
export class OpsSessionService {
  private readonly logger = new Logger(OpsSessionService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    const secret = this.config.getOrThrow<string>('OPS_JWT_SECRET');
    const productSecret = this.config.get<string>('JWT_SECRET');

    // Falha alto: com o mesmo segredo, um `access_token` de cliente passaria a
    // ser um token de operações válido a menos da checagem de `typ`.
    if (productSecret && secret === productSecret) {
      throw new Error('OPS_JWT_SECRET precisa ser diferente de JWT_SECRET');
    }
    return secret;
  }

  async sign(payload: Omit<OpsSessionPayload, 'typ'>): Promise<string> {
    return this.jwt.signAsync(
      { ...payload, typ: OPS_TOKEN_TYPE },
      { secret: this.secret(), expiresIn: OPS_SESSION_TTL_SECONDS },
    );
  }

  /** Devolve o payload, ou `null` se o token é inválido, expirado ou de outro tipo. */
  async verify(token: string): Promise<(OpsSessionPayload & { exp: number }) | null> {
    try {
      const payload = await this.jwt.verifyAsync<OpsSessionPayload & { exp: number }>(token, {
        secret: this.secret(),
      });
      if (payload.typ !== OPS_TOKEN_TYPE) {
        this.logger.warn('Token apresentado em /ops/* não é de operações');
        return null;
      }
      return payload;
    } catch {
      // Não logamos o token nem o motivo detalhado: nada aqui ajuda a operação
      // e o conteúdo é credencial.
      return null;
    }
  }

  /** Grava o cookie de sessão e (re)emite o token CSRF. */
  async issueSessionCookie(res: Response, payload: Omit<OpsSessionPayload, 'typ'>): Promise<void> {
    const token = await this.sign(payload);
    res.cookie(OPS_SESSION_COOKIE, token, {
      ...COOKIE_OPTIONS,
      maxAge: OPS_SESSION_TTL_SECONDS * 1000,
    });
    issueCsrfCookie(res, COOKIE_OPTIONS);
  }

  clearSessionCookie(res: Response): void {
    res.clearCookie(OPS_SESSION_COOKIE, COOKIE_OPTIONS);
  }

  setOauthStateCookie(res: Response, state: string): void {
    res.cookie(OPS_OAUTH_STATE_COOKIE, state, {
      ...COOKIE_OPTIONS,
      maxAge: OPS_OAUTH_STATE_TTL_SECONDS * 1000,
    });
  }

  clearOauthStateCookie(res: Response): void {
    res.clearCookie(OPS_OAUTH_STATE_COOKIE, COOKIE_OPTIONS);
  }
}
