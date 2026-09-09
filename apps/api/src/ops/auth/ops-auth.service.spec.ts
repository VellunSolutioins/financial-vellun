import { OpsAuditResult, OpsRole } from '@prisma/client';

import { OpsAuthService } from './ops-auth.service';

const identidade = { githubUserId: '4242', login: 'alguem', name: 'Alguém', email: 'a@b.c' };

function setup(
  options: {
    isMember?: boolean;
    existing?: Record<string, unknown> | null;
    operatorCount?: number;
    bootstrapLogin?: string;
  } = {},
) {
  const upserted: any[] = [];

  const prisma = {
    opsOperator: {
      count: jest.fn().mockResolvedValue(options.operatorCount ?? 0),
      upsert: jest.fn().mockImplementation(({ create, update }: any) => {
        const row = options.existing
          ? { ...options.existing, ...update }
          : {
              id: 'op-novo',
              role: OpsRole.viewer,
              active: false,
              canViewSensitive: false,
              ...create,
            };
        upserted.push({ create, update });
        return Promise.resolve(row);
      }),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'op-1',
          githubLogin: identidade.login,
          role: OpsRole.operator,
          active: true,
          canViewSensitive: false,
          ...data,
        }),
      ),
      findUnique: jest.fn(),
    },
  } as any;

  const github = {
    exchangeCode: jest.fn().mockResolvedValue('gho_token'),
    fetchIdentity: jest.fn().mockResolvedValue(identidade),
    isActiveOrgMember: jest.fn().mockResolvedValue(options.isMember ?? true),
    organization: 'VellunSolutioins',
  } as any;

  const audit = {
    record: jest.fn().mockResolvedValue('audit-1'),
    recordBestEffort: jest.fn().mockResolvedValue(undefined),
    newOperationId: jest.fn().mockReturnValue('oper-1'),
  } as any;

  const config = {
    get: jest
      .fn()
      .mockImplementation((key: string) =>
        key === 'OPS_BOOTSTRAP_ADMIN_GITHUB_LOGIN' ? options.bootstrapLogin : undefined,
      ),
  } as any;

  return {
    service: new OpsAuthService(prisma, github, audit, config),
    prisma,
    github,
    audit,
    upserted,
  };
}

describe('OpsAuthService', () => {
  describe('state do OAuth', () => {
    it('aceita apenas o state idêntico ao do cookie', () => {
      const { service } = setup();
      const state = service.newOauthState();

      expect(service.stateMatches(state, state)).toBe(true);
      expect(service.stateMatches(state, `${state}x`)).toBe(false);
      expect(service.stateMatches(state, undefined)).toBe(false);
      expect(service.stateMatches(undefined, state)).toBe(false);
      expect(service.stateMatches('', '')).toBe(false);
    });
  });

  describe('completeLogin', () => {
    it('recusa quem não pertence à organização e não o registra como operador', async () => {
      // Critério de aceite: quem não é da org não completa o login. E a tabela de
      // operadores é a lista de operadores conhecidos, não um log de tentativas.
      const { service, prisma } = setup({ isMember: false });

      await expect(service.completeLogin('code')).resolves.toEqual({
        status: 'rejected',
        reason: 'not_org_member',
        operator: null,
      });
      expect(prisma.opsOperator.upsert).not.toHaveBeenCalled();
    });

    it('recusa convite pendente na organização como se não fosse membro', async () => {
      // `isActiveOrgMember` já traduz `pending` para false; aqui garantimos que a
      // decisão do serviço é a mesma de quem não pertence.
      const { service } = setup({ isMember: false });
      const outcome = await service.completeLogin('code');

      expect(outcome.status).toBe('rejected');
    });

    it('registra o primeiro login como viewer inativo e não emite sessão', async () => {
      const { service, upserted } = setup({ isMember: true });

      const outcome = await service.completeLogin('code');

      expect(outcome).toMatchObject({ status: 'rejected', reason: 'inactive' });
      // O upsert não pede papel nem ativação: o default do schema decide.
      expect(upserted[0].create).not.toHaveProperty('role');
      expect(upserted[0].create).not.toHaveProperty('active');
    });

    it('não reescreve papel nem ativação no login de quem já é operador', async () => {
      // Fazer login não é caminho para ganhar (ou perder) permissão.
      const { service, upserted } = setup({
        isMember: true,
        existing: {
          id: 'op-1',
          githubLogin: 'alguem',
          role: OpsRole.operator,
          active: true,
          canViewSensitive: true,
        },
        operatorCount: 1,
      });

      await service.completeLogin('code');

      expect(Object.keys(upserted[0].update).sort()).toEqual(['email', 'githubLogin', 'name']);
    });

    it('autoriza operador ativo, marca lastLoginAt e audita', async () => {
      const { service, prisma, audit } = setup({
        isMember: true,
        existing: {
          id: 'op-1',
          githubLogin: 'alguem',
          role: OpsRole.operator,
          active: true,
          canViewSensitive: false,
        },
        operatorCount: 1,
      });

      const outcome = await service.completeLogin('code');

      expect(outcome.status).toBe('authorized');
      expect(prisma.opsOperator.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastLoginAt: expect.any(Date) } }),
      );
      expect(audit.recordBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({ result: OpsAuditResult.success }),
      );
    });

    it('audita a recusa do operador inativo', async () => {
      const { service, audit } = setup({
        isMember: true,
        existing: {
          id: 'op-1',
          githubLogin: 'alguem',
          role: OpsRole.viewer,
          active: false,
          canViewSensitive: false,
        },
        operatorCount: 1,
      });

      await service.completeLogin('code');

      expect(audit.recordBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({ result: OpsAuditResult.denied }),
      );
    });
  });

  describe('semeadura do primeiro ops_admin', () => {
    it('promove o login nomeado quando a tabela está vazia', async () => {
      const { service, upserted } = setup({
        isMember: true,
        operatorCount: 0,
        bootstrapLogin: 'alguem',
      });

      await service.completeLogin('code');

      expect(upserted[0].create).toMatchObject({ role: OpsRole.ops_admin, active: true });
    });

    it('compara o login sem diferenciar caixa', async () => {
      const { service, upserted } = setup({
        isMember: true,
        operatorCount: 0,
        bootstrapLogin: 'AlGuEm',
      });

      await service.completeLogin('code');

      expect(upserted[0].create).toMatchObject({ role: OpsRole.ops_admin });
    });

    it('não promove outro login, mesmo com a tabela vazia', async () => {
      const { service, upserted } = setup({
        isMember: true,
        operatorCount: 0,
        bootstrapLogin: 'outra-pessoa',
      });

      await service.completeLogin('code');

      expect(upserted[0].create).not.toHaveProperty('role');
    });

    it('perde efeito assim que existe qualquer operador', async () => {
      // A variável esquecida no ambiente não reabre a porta.
      const { service, upserted } = setup({
        isMember: true,
        operatorCount: 1,
        bootstrapLogin: 'alguem',
      });

      await service.completeLogin('code');

      expect(upserted[0].create).not.toHaveProperty('role');
    });

    it('não promove ninguém quando a variável não está configurada', async () => {
      const { service, upserted, prisma } = setup({ isMember: true, operatorCount: 0 });

      await service.completeLogin('code');

      expect(upserted[0].create).not.toHaveProperty('role');
      // Nem consulta a contagem: sem a variável, não há semeadura possível.
      expect(prisma.opsOperator.count).not.toHaveBeenCalled();
    });
  });
});
