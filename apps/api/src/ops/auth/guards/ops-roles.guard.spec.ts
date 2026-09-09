import { ForbiddenException } from '@nestjs/common';
import { OpsAuditResult, OpsRole } from '@prisma/client';

import { OpsRolesGuard } from './ops-roles.guard';

function context(operator: unknown, path = '/ops/failures/:id/reprocess') {
  return {
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({
      getRequest: () => ({ opsOperator: operator, method: 'POST', path, route: { path } }),
    }),
  } as any;
}

function setup(required: OpsRole[] | undefined) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(required) } as any;
  const audit = { recordBestEffort: jest.fn().mockResolvedValue(undefined) } as any;
  return { guard: new OpsRolesGuard(reflector, audit), audit };
}

const viewer = { id: 'op-v', githubLogin: 'v', role: OpsRole.viewer, canViewSensitive: false };
const operator = { id: 'op-o', githubLogin: 'o', role: OpsRole.operator, canViewSensitive: false };
const admin = { id: 'op-a', githubLogin: 'a', role: OpsRole.ops_admin, canViewSensitive: true };

describe('OpsRolesGuard', () => {
  it('libera rota sem @OpsRoles para qualquer operador ativo', async () => {
    const { guard } = setup(undefined);
    await expect(guard.canActivate(context(viewer))).resolves.toBe(true);
  });

  it('libera o papel listado', async () => {
    const { guard } = setup([OpsRole.operator, OpsRole.ops_admin]);
    await expect(guard.canActivate(context(operator))).resolves.toBe(true);
  });

  it('recusa viewer em rota de reprocessamento', async () => {
    // Critério de aceite: `viewer` recebe 403 ao tentar reprocessar.
    const { guard } = setup([OpsRole.operator, OpsRole.ops_admin]);

    await expect(guard.canActivate(context(viewer))).rejects.toMatchObject({
      status: 403,
      response: { code: 'OPS_ROLE_REQUIRED' },
    });
  });

  it('recusa operator em rota restrita a ops_admin', async () => {
    const { guard } = setup([OpsRole.ops_admin]);
    await expect(guard.canActivate(context(operator))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('não trata os papéis como hierárquicos: ops_admin fora da lista é recusado', async () => {
    // Ler `@OpsRoles('operator')` tem de bastar para saber quem pode.
    const { guard } = setup([OpsRole.operator]);
    await expect(guard.canActivate(context(admin))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('audita a tentativa recusada com result denied', async () => {
    const { guard, audit } = setup([OpsRole.operator]);

    await expect(guard.canActivate(context(viewer))).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: 'op-v',
        result: OpsAuditResult.denied,
        action: 'POST /ops/failures/:id/reprocess',
      }),
    );
  });

  it('acusa erro de montagem quando a rota não tem OpsAuthGuard', async () => {
    // Falha de programação, não de autorização: precisa ser 500, não 403 — um
    // 403 aqui esconderia uma rota sem autenticação nenhuma.
    const { guard } = setup([OpsRole.operator]);
    await expect(guard.canActivate(context(undefined))).rejects.toThrow(/exige OpsAuthGuard/);
  });
});
