import { AiRetentionService, CONTEUDO_EXPURGADO } from './ai-retention.service';

function createPrismaMock(mensagens = 0, extracoes = 0) {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${i}` }));
  return {
    aiMessage: {
      findMany: jest.fn().mockResolvedValueOnce(ids(mensagens)).mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: mensagens }),
    },
    aiExtractedTransaction: {
      findMany: jest.fn().mockResolvedValueOnce(ids(extracoes)).mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: extracoes }),
    },
  };
}

function createService(prisma: any, dias?: string) {
  const config = { get: () => dias } as any;
  return new AiRetentionService(prisma, config);
}

describe('AiRetentionService', () => {
  it('apaga o texto e mantém a linha, depois do prazo', async () => {
    const prisma = createPrismaMock(2, 1);
    const service = createService(prisma, '90');

    const resultado = await service.purgeExpired();

    expect(resultado).toEqual({ mensagens: 2, extracoes: 1 });
    const filtro = prisma.aiMessage.findMany.mock.calls[0][0].where;
    // Só o que passou do prazo, e nada que já tenha sido expurgado.
    expect(filtro.createdAt.lt.getTime()).toBeLessThan(Date.now());
    expect(filtro.content).toEqual({ not: CONTEUDO_EXPURGADO });
    expect(prisma.aiMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['id-0', 'id-1'] } },
      data: { content: CONTEUDO_EXPURGADO },
    });
    expect(prisma.aiExtractedTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['id-0'] } },
      data: { rawInput: CONTEUDO_EXPURGADO },
    });
  });

  it('usa 90 dias quando a configuração está ausente ou inválida', async () => {
    const prisma = createPrismaMock(1);
    await createService(prisma, 'abc').purgeExpired();

    const limite = prisma.aiMessage.findMany.mock.calls[0][0].where.createdAt.lt as Date;
    const dias = (Date.now() - limite.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(dias)).toBe(90);
  });

  it('zero desliga o expurgo', async () => {
    const prisma = createPrismaMock(5);

    await expect(createService(prisma, '0').purgeExpired()).resolves.toEqual({
      mensagens: 0,
      extracoes: 0,
    });
    expect(prisma.aiMessage.findMany).not.toHaveBeenCalled();
  });

  it('falha no banco não derruba o processo', async () => {
    const prisma = createPrismaMock();
    prisma.aiMessage.findMany.mockRejectedValue(new Error('banco fora'));

    await expect(createService(prisma, '90').purgeExpired()).resolves.toEqual({
      mensagens: 0,
      extracoes: 0,
    });
  });

  it('não roda duas vezes ao mesmo tempo no mesmo processo', async () => {
    const prisma = createPrismaMock(1);
    const service = createService(prisma, '90');

    const [primeira, segunda] = await Promise.all([service.purgeExpired(), service.purgeExpired()]);

    // Uma das duas devolve zero sem tocar no banco de novo.
    expect([primeira.mensagens, segunda.mensagens].sort()).toEqual([0, 1]);
  });
});
