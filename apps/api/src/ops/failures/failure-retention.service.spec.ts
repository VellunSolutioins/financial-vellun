import { FailureRetentionService } from './failure-retention.service';

function setup(lotes: string[][]) {
  const restantes = [...lotes];
  const apagados: string[][] = [];

  const prisma = {
    opsFailedMessage: {
      findMany: jest.fn().mockImplementation(() => {
        const lote = restantes.shift() ?? [];
        return Promise.resolve(lote.map((id) => ({ id })));
      }),
      deleteMany: jest.fn().mockImplementation(({ where }: any) => {
        apagados.push(where.id.in);
        return Promise.resolve({ count: where.id.in.length });
      }),
    },
  } as any;

  return { service: new FailureRetentionService(prisma), prisma, apagados };
}

/** Um lote cheio, para exercitar a paginação. */
const lote = (prefixo: string) => Array.from({ length: 500 }, (_, i) => `${prefixo}-${i}`);

describe('FailureRetentionService.purgeExpired', () => {
  it('remove apenas o que já venceu a retenção', async () => {
    const { service, prisma } = setup([['expirada-1', 'expirada-2']]);

    await expect(service.purgeExpired()).resolves.toBe(2);

    const where = prisma.opsFailedMessage.findMany.mock.calls[0][0].where;
    expect(where.retentionUntil.lt).toBeInstanceOf(Date);
  });

  it('não faz nada quando não há vencidas', async () => {
    const { service, prisma } = setup([[]]);

    await expect(service.purgeExpired()).resolves.toBe(0);
    expect(prisma.opsFailedMessage.deleteMany).not.toHaveBeenCalled();
  });

  it('processa em lotes, para não segurar lock longo na tabela que o painel lê', async () => {
    const { service, apagados } = setup([lote('a'), ['b-1']]);

    await expect(service.purgeExpired()).resolves.toBe(501);
    expect(apagados).toHaveLength(2);
    expect(apagados[0]).toHaveLength(500);
  });

  it('para quando o lote vem incompleto', async () => {
    // Lote menor que o teto significa que acabou; buscar de novo seria uma
    // consulta a mais em toda execução.
    const { service, prisma } = setup([['unica']]);

    await service.purgeExpired();

    expect(prisma.opsFailedMessage.findMany).toHaveBeenCalledTimes(1);
  });

  it('não deixa dois ciclos se sobreporem', async () => {
    const { service, prisma } = setup([lote('a'), lote('b'), []]);

    const primeiro = service.purgeExpired();
    const segundo = service.purgeExpired();

    await expect(segundo).resolves.toBe(0);
    await primeiro;
    // O segundo saiu na guarda, sem tocar no banco.
    expect(prisma.opsFailedMessage.findMany.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('libera a guarda mesmo se o banco falhar', async () => {
    // Sem isso, um erro travaria o expurgo para sempre e a tabela cresceria
    // indefinidamente sem ninguém notar.
    const prisma = {
      opsFailedMessage: {
        findMany: jest.fn().mockRejectedValue(new Error('banco fora')),
        deleteMany: jest.fn(),
      },
    } as any;
    const service = new FailureRetentionService(prisma);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    await expect(service.purgeExpired()).resolves.toBe(0);
    // A segunda execução volta a tentar, em vez de sair pela guarda.
    await expect(service.purgeExpired()).resolves.toBe(0);
    expect(prisma.opsFailedMessage.findMany).toHaveBeenCalledTimes(2);
  });
});
