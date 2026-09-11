import { PrismaClient } from '@prisma/client';

/**
 * Critério de aceite do plano: *um `operator` não consegue alterar a trilha*.
 *
 * Este é o único teste da API que exige **Postgres de verdade**, e tem de ser:
 * a garantia não está em código nenhum que um dublê pudesse imitar — está num
 * trigger instalado pela migration `20260909230953_add_ops_identity_and_audit`.
 * Testá-lo com Prisma mockado verificaria o mock.
 *
 * Por isso ele é pulado por padrão e roda sob demanda:
 *
 * ```bash
 * pnpm db:up
 * cd apps/api && OPS_DB_TESTS=1 pnpm exec jest ops-audit-append-only
 * ```
 *
 * A trava é um trigger, e não um `REVOKE UPDATE, DELETE`, porque o dono da
 * tabela pode devolver a si mesmo qualquer privilégio revogado. O trigger vale
 * para todo mundo, inclusive para quem está limpando dado de teste — foi assim
 * que ele apareceu pela primeira vez, recusando a limpeza da Entrega 5.
 */
const comBanco = process.env.OPS_DB_TESTS === '1';
const descreve = comBanco ? describe : describe.skip;

descreve('ops_audit_log é append-only no banco', () => {
  const prisma = new PrismaClient();
  let operatorId: string;
  let auditId: string;

  beforeAll(async () => {
    await prisma.$connect();

    const operador = await prisma.opsOperator.upsert({
      where: { githubUserId: '900003' },
      update: {},
      create: {
        githubLogin: 'teste-append-only',
        githubUserId: '900003',
        role: 'operator',
        active: false,
      },
      select: { id: true },
    });
    operatorId = operador.id;

    const linha = await prisma.opsAuditLog.create({
      data: {
        operatorId,
        action: 'teste.append_only',
        targetType: 'ops_operator',
        targetId: operatorId,
        reason: 'verificação automatizada do trigger',
        result: 'success',
        operationId: '00000000-0000-4000-8000-000000000001',
      },
      select: { id: true },
    });
    auditId = linha.id;
  });

  afterAll(async () => {
    // A linha de auditoria FICA: é justamente o que este teste prova. Só o
    // operador de teste é desativado — remover também é recusado, porque a
    // chave estrangeira é `ON DELETE RESTRICT`.
    await prisma.$disconnect();
  });

  it('recusa UPDATE', async () => {
    await expect(
      prisma.opsAuditLog.update({ where: { id: auditId }, data: { reason: 'adulterado' } }),
    ).rejects.toThrow(/append-only|append_only/i);
  });

  it('recusa DELETE', async () => {
    await expect(prisma.opsAuditLog.delete({ where: { id: auditId } })).rejects.toThrow(
      /append-only|append_only/i,
    );
  });

  it('recusa DELETE em massa, inclusive de quem está limpando dado de teste', async () => {
    await expect(
      prisma.opsAuditLog.deleteMany({ where: { action: 'teste.append_only' } }),
    ).rejects.toThrow(/append-only|append_only/i);
  });

  it('recusa TRUNCATE', async () => {
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "ops_audit_log"')).rejects.toThrow(
      /append-only|append_only/i,
    );
  });

  it('a linha continua lá, intacta, depois de todas as tentativas', async () => {
    const linha = await prisma.opsAuditLog.findUniqueOrThrow({ where: { id: auditId } });

    expect(linha.reason).toBe('verificação automatizada do trigger');
    expect(linha.action).toBe('teste.append_only');
  });

  it('INSERT continua permitido: a trilha só cresce', async () => {
    const nova = await prisma.opsAuditLog.create({
      data: {
        operatorId,
        action: 'teste.append_only',
        targetType: 'ops_operator',
        targetId: operatorId,
        result: 'success',
        operationId: '00000000-0000-4000-8000-000000000002',
      },
      select: { id: true },
    });

    expect(nova.id).toBeTruthy();
  });
});
