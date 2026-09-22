import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { CookieOptions, Request, Response } from 'express';

import { CSRF_COOKIE, issueCsrfCookie } from '../common/csrf.util';
import { randomToken, safeEqual, sha256Hex } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
/** O refresh token só viaja para a rota que o consome. */
export const REFRESH_COOKIE_PATH = '/auth/refresh';

const ACCESS_TTL_MS = 15 * 60 * 1000;
/** Expiração deslizante: renovada a cada refresh. */
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Prazo máximo de um login, por mais que ele seja renovado. */
const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Janela em que o token anterior ainda é aceito sem ser tratado como roubo:
 * duas abas renovando ao mesmo tempo enviam o mesmo token.
 */
const ROTATION_GRACE_MS = 60 * 1000;

const USER_AGENT_MAX = 255;

interface AccessPayload {
  sub: string;
  sid: string;
  typ: 'access';
}

interface RefreshPayload {
  sub: string;
  sid: string;
  typ: 'refresh';
  rt: string;
}

export interface IssuedTokens {
  accessToken: string;
  /** `null` quando a renovação caiu na janela de tolerância (ver `refresh`). */
  refreshToken: string | null;
}

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

/** Usuário autenticado como os controllers recebem em `req.user`. */
export type AuthenticatedUser = User & { sessionId: string };

/**
 * Sessões de login revogáveis (plano de segurança, S1.3).
 *
 * Cada login cria uma `UserSession`. O access token (15 min) carrega o id da
 * sessão e é validado contra ela em toda requisição, na mesma consulta que já
 * carregava o usuário: revogar uma sessão derruba seu acesso imediatamente.
 *
 * O refresh token é de uso único: cada renovação troca o segredo guardado na
 * sessão. Apresentar um segredo antigo fora da janela de tolerância é
 * reutilização — sinal de token roubado — e revoga a sessão inteira.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly isProduction = process.env.NODE_ENV === 'production';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ── Emissão ──────────────────────────────────────────────────────────────

  async createSession(userId: string, meta: SessionMeta = {}): Promise<IssuedTokens> {
    const now = Date.now();
    const secret = randomToken();
    const session = await this.prisma.userSession.create({
      data: {
        userId,
        refreshTokenHash: sha256Hex(secret),
        userAgent: meta.userAgent?.slice(0, USER_AGENT_MAX),
        ip: meta.ip,
        expiresAt: new Date(now + REFRESH_TTL_MS),
        absoluteExpiresAt: new Date(now + ABSOLUTE_TTL_MS),
      },
    });
    return {
      accessToken: await this.signAccess(userId, session.id),
      refreshToken: await this.signRefresh(userId, session.id, secret),
    };
  }

  /**
   * Gira o refresh token. Lança `UnauthorizedException` para token inválido,
   * sessão encerrada ou reutilização detectada.
   */
  async refresh(refreshToken: string | undefined): Promise<IssuedTokens> {
    const payload = await this.verifyRefresh(refreshToken);
    const session = await this.prisma.userSession.findUnique({ where: { id: payload.sid } });
    const now = new Date();

    if (!session || session.userId !== payload.sub || !this.isAlive(session, now)) {
      throw new UnauthorizedException('Sessão encerrada');
    }

    const presentedHash = sha256Hex(payload.rt);

    if (safeEqual(presentedHash, session.refreshTokenHash)) {
      const secret = randomToken();
      // Condicional ao hash atual: duas renovações simultâneas com o mesmo
      // token não giram duas vezes — a segunda cai no ramo de tolerância.
      const { count } = await this.prisma.userSession.updateMany({
        where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
        data: {
          refreshTokenHash: sha256Hex(secret),
          previousTokenHash: session.refreshTokenHash,
          rotatedAt: now,
          lastUsedAt: now,
          expiresAt: new Date(
            Math.min(now.getTime() + REFRESH_TTL_MS, session.absoluteExpiresAt.getTime()),
          ),
        },
      });
      if (count === 1) {
        return {
          accessToken: await this.signAccess(session.userId, session.id),
          refreshToken: await this.signRefresh(session.userId, session.id, secret),
        };
      }
      // Perdeu a corrida para outra renovação: é o mesmo caso da tolerância.
      return { accessToken: await this.signAccess(session.userId, session.id), refreshToken: null };
    }

    const withinGrace =
      session.previousTokenHash !== null &&
      session.rotatedAt !== null &&
      safeEqual(presentedHash, session.previousTokenHash) &&
      now.getTime() - session.rotatedAt.getTime() <= ROTATION_GRACE_MS;

    if (withinGrace) {
      // Outra aba acabou de girar o token. Emite só o access token e não mexe
      // no cookie de refresh, que já recebeu (ou vai receber) o token novo.
      return { accessToken: await this.signAccess(session.userId, session.id), refreshToken: null };
    }

    await this.revokeSession(session.id);
    this.logger.warn(`Reutilização de refresh token detectada; sessão ${session.id} revogada`);
    throw new UnauthorizedException('Sessão encerrada');
  }

  // ── Validação do access token ────────────────────────────────────────────

  /** Usado pela `JwtStrategy`: uma consulta traz sessão e usuário juntos. */
  async validateAccess(payload: Partial<AccessPayload>): Promise<AuthenticatedUser> {
    if (payload.typ !== 'access' || !payload.sid || !payload.sub) {
      throw new UnauthorizedException();
    }
    const session = await this.prisma.userSession.findUnique({
      where: { id: payload.sid },
      include: { user: true },
    });
    if (!session || session.userId !== payload.sub || !this.isAlive(session, new Date())) {
      throw new UnauthorizedException();
    }
    return { ...session.user, sessionId: session.id };
  }

  // ── Revogação ────────────────────────────────────────────────────────────

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Encerra todas as sessões do usuário, exceto `exceptSessionId` quando informado. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    const { count } = await this.prisma.userSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  /**
   * Descobre a sessão pelos cookies, para o logout. Aceita access token
   * expirado: sair não pode depender de a sessão ainda estar ativa.
   */
  async sessionIdFromRequest(req: Request): Promise<string | null> {
    const access = req.cookies?.[ACCESS_COOKIE] as string | undefined;
    if (access) {
      try {
        const payload = await this.jwt.verifyAsync<AccessPayload>(access, {
          secret: this.config.getOrThrow<string>('JWT_SECRET'),
          ignoreExpiration: true,
        });
        if (payload.sid) return payload.sid;
      } catch {
        // Assinatura inválida: ignora e tenta o refresh.
      }
    }
    const refresh = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (refresh) {
      try {
        const payload = await this.jwt.verifyAsync<RefreshPayload>(refresh, {
          secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
          ignoreExpiration: true,
        });
        if (payload.sid) return payload.sid;
      } catch {
        return null;
      }
    }
    return null;
  }

  // ── Cookies ──────────────────────────────────────────────────────────────

  get cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: this.isProduction ? 'none' : 'lax',
      secure: this.isProduction,
    };
  }

  setAuthCookies(res: Response, tokens: IssuedTokens): void {
    const base = this.cookieOptions;
    res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...base, maxAge: ACCESS_TTL_MS });
    if (tokens.refreshToken) {
      res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
        ...base,
        path: REFRESH_COOKIE_PATH,
        maxAge: REFRESH_TTL_MS,
      });
      // Versões anteriores gravavam o refresh no path `/`; sem limpar, o cookie
      // antigo continuaria indo em toda requisição até expirar.
      res.clearCookie(REFRESH_COOKIE, base);
    }
    issueCsrfCookie(res, base);
  }

  clearAuthCookies(res: Response): void {
    const base = this.cookieOptions;
    res.clearCookie(ACCESS_COOKIE, base);
    res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
    res.clearCookie(REFRESH_COOKIE, base);
    res.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  private isAlive(
    session: { revokedAt: Date | null; expiresAt: Date; absoluteExpiresAt: Date },
    now: Date,
  ): boolean {
    return (
      session.revokedAt === null &&
      session.expiresAt.getTime() > now.getTime() &&
      session.absoluteExpiresAt.getTime() > now.getTime()
    );
  }

  private signAccess(userId: string, sessionId: string): Promise<string> {
    const payload: AccessPayload = { sub: userId, sid: sessionId, typ: 'access' };
    return this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_SECRET'),
      expiresIn: ACCESS_TTL_MS / 1000,
    });
  }

  private signRefresh(userId: string, sessionId: string, secret: string): Promise<string> {
    const payload: RefreshPayload = { sub: userId, sid: sessionId, typ: 'refresh', rt: secret };
    return this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: REFRESH_TTL_MS / 1000,
    });
  }

  private async verifyRefresh(token: string | undefined): Promise<RefreshPayload> {
    if (!token) throw new UnauthorizedException('Sessão encerrada');
    try {
      const payload = await this.jwt.verifyAsync<RefreshPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
      if (payload.typ !== 'refresh' || !payload.sid || !payload.rt) throw new Error('formato');
      return payload;
    } catch {
      throw new UnauthorizedException('Sessão encerrada');
    }
  }
}
