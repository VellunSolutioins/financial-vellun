import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { SessionService } from './session.service';

interface SessionRow {
  id: string;
  userId: string;
  refreshTokenHash: string;
  previousTokenHash: string | null;
  rotatedAt: Date | null;
  lastUsedAt: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Prisma falso só com o que o serviço usa de `userSession`. O `updateMany`
 * respeita o `where` como o banco: é ele que torna a rotação condicional.
 */
function createPrismaFake() {
  const rows = new Map<string, SessionRow>();
  let seq = 0;
  const user = { id: 'user-1', email: 'joao@example.com', name: 'Joao' };

  const matches = (row: SessionRow, where: Record<string, any>) =>
    Object.entries(where).every(([key, expected]) => {
      const value = (row as any)[key];
      if (expected && typeof expected === 'object' && 'not' in expected) {
        return value !== expected.not;
      }
      return value === expected;
    });

  const userSession = {
    create: jest.fn(async ({ data }: { data: Partial<SessionRow> }) => {
      const row: SessionRow = {
        id: `session-${++seq}`,
        previousTokenHash: null,
        rotatedAt: null,
        revokedAt: null,
        lastUsedAt: new Date(),
        ...(data as SessionRow),
      };
      rows.set(row.id, row);
      return row;
    }),
    findUnique: jest.fn(async ({ where, include }: any) => {
      const row = rows.get(where.id);
      if (!row) return null;
      return include?.user ? { ...row, user } : { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of rows.values()) {
        if (matches(row, where)) {
          Object.assign(row, data);
          count++;
        }
      }
      return { count };
    }),
  };

  return { rows, prisma: { userSession } };
}

function createService() {
  const { rows, prisma } = createPrismaFake();
  const config = {
    getOrThrow: (key: string) =>
      ({ JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) })[key],
  };
  const jwt = new JwtService({});
  const service = new SessionService(prisma as any, jwt, config as any);
  return { service, rows, jwt };
}

describe('SessionService', () => {
  it('login cria sessão e o access token é aceito', async () => {
    const { service, jwt } = createService();

    const tokens = await service.createSession('user-1', { userAgent: 'jest', ip: '::1' });
    const payload = jwt.decode(tokens.accessToken) as Record<string, unknown>;

    const user = await service.validateAccess(payload);
    expect(user.id).toBe('user-1');
    expect(user.sessionId).toBe(payload.sid);
  });

  it('logout revoga a sessão e o access token deixa de valer', async () => {
    const { service, jwt } = createService();
    const tokens = await service.createSession('user-1');
    const payload = jwt.decode(tokens.accessToken) as { sid: string };

    await service.revokeSession(payload.sid);

    await expect(service.validateAccess(payload as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('recusa token sem sessão (emitido antes desta versão)', async () => {
    const { service } = createService();
    await expect(service.validateAccess({ sub: 'user-1' } as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refresh gira o token: o novo funciona e o antigo não', async () => {
    const { service, rows } = createService();
    const first = await service.createSession('user-1');

    const second = await service.refresh(first.refreshToken!);
    expect(second.refreshToken).toBeTruthy();
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // Passada a janela de tolerância, o token antigo é reutilização.
    const [row] = rows.values();
    row.rotatedAt = new Date(Date.now() - 5 * 60 * 1000);

    await expect(service.refresh(first.refreshToken!)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(row.revokedAt).not.toBeNull();
    // A reutilização derruba a sessão inteira, inclusive o token legítimo.
    await expect(service.refresh(second.refreshToken!)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('duas abas renovando juntas não derrubam a sessão', async () => {
    const { service, rows } = createService();
    const first = await service.createSession('user-1');

    await service.refresh(first.refreshToken!);
    const concurrent = await service.refresh(first.refreshToken!);

    expect(concurrent.accessToken).toBeTruthy();
    expect(concurrent.refreshToken).toBeNull();
    const [row] = rows.values();
    expect(row.revokedAt).toBeNull();
  });

  it('não renova depois do prazo absoluto', async () => {
    const { service, rows } = createService();
    const tokens = await service.createSession('user-1');
    const [row] = rows.values();
    row.absoluteExpiresAt = new Date(Date.now() - 1000);

    await expect(service.refresh(tokens.refreshToken!)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('recusa access token apresentado como refresh', async () => {
    const { service } = createService();
    const tokens = await service.createSession('user-1');

    await expect(service.refresh(tokens.accessToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokeAllForUser preserva só a sessão indicada', async () => {
    const { service, jwt } = createService();
    const a = await service.createSession('user-1');
    const b = await service.createSession('user-1');
    const keep = (jwt.decode(a.accessToken) as { sid: string }).sid;

    const count = await service.revokeAllForUser('user-1', keep);

    expect(count).toBe(1);
    await expect(service.validateAccess(jwt.decode(a.accessToken) as any)).resolves.toBeTruthy();
    await expect(service.validateAccess(jwt.decode(b.accessToken) as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('logout encontra a sessão mesmo com o access token expirado', async () => {
    const { service, jwt } = createService();
    const tokens = await service.createSession('user-1');
    const { sid } = jwt.decode(tokens.accessToken) as { sid: string };
    const expired = await jwt.signAsync(
      { sub: 'user-1', sid, typ: 'access', exp: Math.floor(Date.now() / 1000) - 60 },
      { secret: 'x'.repeat(32) },
    );

    const found = await service.sessionIdFromRequest({ cookies: { access_token: expired } } as any);
    expect(found).toBe(sid);
  });
});
