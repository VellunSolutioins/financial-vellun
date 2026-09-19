import { ForbiddenException } from '@nestjs/common';
import { OpsRole } from '@prisma/client';

import { OPS_SESSION_TTL_SECONDS } from '../../ops.constants';
import { OpsAuthGuard } from './ops-auth.guard';

function context(cookies: Record<string, string> = {}) {
  const request: any = { cookies };
  const response: any = { cookie: jest.fn(), clearCookie: jest.fn() };
  return {
    ctx: {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as any,
    request,
    response,
  };
}

const now = () => Math.floor(Date.now() / 1000);

function setup(options: {
  payload?: Record<string, unknown> | null;
  operator?: Record<string, unknown> | null;
}) {
  const session = {
    verify: jest.fn().mockResolvedValue(options.payload ?? null),
    issueSessionCookie: jest.fn().mockResolvedValue(undefined),
    clearSessionCookie: jest.fn(),
  } as any;
  const auth = { findById: jest.fn().mockResolvedValue(options.operator ?? null) } as any;

  return { guard: new OpsAuthGuard(session, auth), session, auth };
}

const operadorAtivo = {
  id: 'op-1',
  githubLogin: 'alguem',
  role: OpsRole.operator,
  canViewSensitive: false,
  active: true,
};

describe('OpsAuthGuard', () => {
  it('recusa com 403 quem não tem cookie de operações', async () => {
    const { guard } = setup({});
    const { ctx } = context();

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('recusa um usuário autenticado no produto (só access_token)', async () => {
    // Critério de aceite: usuário comum do produto recebe 403 em toda rota /ops/*.
    const { guard, session } = setup({});
    const { ctx } = context({ access_token: 'jwt-do-produto', csrf_token: 'abc' });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    // Nem chega a tentar verificar: não há cookie de ops para apresentar.
    expect(session.verify).not.toHaveBeenCalled();
  });

  it('responde 403 (nunca 401) para não convidar o usuário do produto a autenticar', async () => {
    const { guard } = setup({});
    const { ctx } = context({ ops_session: 'invalido' });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      status: 403,
      response: { code: 'OPS_SESSION_REQUIRED' },
    });
  });

  it('recusa e limpa o cookie quando o operador foi desativado após emitir a sessão', async () => {
    const { guard, session } = setup({
      payload: { sub: 'op-1', exp: now() + OPS_SESSION_TTL_SECONDS },
      operator: { ...operadorAtivo, active: false },
    });
    const { ctx, response } = context({ ops_session: 'valido' });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    // Não basta negar: a sessão precisa morrer, senão o operador desativado
    // continua batendo na porta com um cookie que o browser guarda por 30 min.
    expect(session.clearSessionCookie).toHaveBeenCalledWith(response);
  });

  it('recusa quando o operador do token não existe mais', async () => {
    const { guard } = setup({
      payload: { sub: 'op-apagado', exp: now() + OPS_SESSION_TTL_SECONDS },
      operator: null,
    });
    const { ctx } = context({ ops_session: 'valido' });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('popula o operador com o estado do banco, não com o do token', async () => {
    // Revogar permissão precisa valer na próxima requisição, sem esperar o TTL.
    const { guard } = setup({
      payload: {
        sub: 'op-1',
        role: OpsRole.ops_admin,
        cvs: true,
        exp: now() + OPS_SESSION_TTL_SECONDS,
      },
      operator: operadorAtivo,
    });
    const { ctx, request } = context({ ops_session: 'valido' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.opsOperator).toEqual({
      id: 'op-1',
      githubLogin: 'alguem',
      role: OpsRole.operator,
      canViewSensitive: false,
    });
  });

  it('não reemite o cookie quando a sessão está longe de expirar', async () => {
    const { guard, session } = setup({
      payload: { sub: 'op-1', exp: now() + OPS_SESSION_TTL_SECONDS },
      operator: operadorAtivo,
    });
    const { ctx } = context({ ops_session: 'valido' });

    await guard.canActivate(ctx);
    expect(session.issueSessionCookie).not.toHaveBeenCalled();
  });

  it('renova a sessão quando falta pouco para expirar', async () => {
    const { guard, session } = setup({
      payload: { sub: 'op-1', exp: now() + 60 },
      operator: operadorAtivo,
    });
    const { ctx } = context({ ops_session: 'quase-expirado' });

    await guard.canActivate(ctx);
    expect(session.issueSessionCookie).toHaveBeenCalledWith(expect.anything(), {
      sub: 'op-1',
      login: 'alguem',
      role: OpsRole.operator,
      cvs: false,
    });
  });
});
