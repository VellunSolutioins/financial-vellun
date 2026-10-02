import { BadRequestException, ConflictException } from '@nestjs/common';

import {
  InstallmentsService,
  buildInstallmentsSummary,
  groupInstallments,
  sortInstallments,
  type Parcel,
} from './installments.service';

const TODAY = new Date(Date.UTC(2026, 9, 10));
const day = (month: number, d = 5) => new Date(Date.UTC(2026, month, d, 12));

/** Compra em 4x com parcelas em ago, set, out e nov (hoje = 10/out). */
const parcel = (n: number, overrides: Partial<Parcel> = {}): Parcel =>
  ({
    id: `p${n}`,
    seriesId: 's1',
    description: 'Notebook',
    type: 'expense',
    amount: 250,
    status: 'confirmed',
    recurrenceType: 'parcelado',
    installmentNumber: n,
    installmentTotal: 4,
    transactionDate: day(6 + n, n === 3 ? 15 : 5),
    accountId: 'a1',
    categoryId: 'c1',
    invoiceId: null,
    cardPaymentId: null,
    advancedAt: null,
    settledAmount: 0,
    forecast: false,
    eventDate: day(7),
    invoice: null,
    purchase: null,
    account: { id: 'a1', name: 'Conta', type: 'checking' },
    category: { id: 'c1', name: 'Eletrônicos', color: null },
    ...overrides,
  }) as unknown as Parcel;

const fourParcels = () => [1, 2, 3, 4].map((n) => parcel(n));

describe('groupInstallments', () => {
  it('resume a compra: total, progresso e próxima parcela', () => {
    const [i] = groupInstallments(fourParcels(), TODAY, new Map());

    expect(i).toMatchObject({
      seriesId: 's1',
      totalAmount: 1000,
      installmentAmount: 250,
      installmentTotal: 4,
      pastCount: 2,
      futureCount: 2,
      status: 'active',
      nextNumber: 3,
      canDeleteAll: true,
      canDeleteFuture: true,
      refundAnchorId: 'p1',
    });
  });

  it('parcela travada no passado bloqueia a compra inteira, mas não as futuras', () => {
    const [i] = groupInstallments(
      fourParcels(),
      TODAY,
      new Map([['p1', 'Este lançamento está em uma fatura fechada.']]),
    );

    expect(i.canDeleteAll).toBe(false);
    expect(i.deleteAllBlockedReason).toContain('fatura fechada');
    expect(i.canDeleteFuture).toBe(true);
  });

  it('compra com todas as parcelas no passado fica encerrada e sem exclusão das futuras', () => {
    const [i] = groupInstallments(fourParcels(), new Date(Date.UTC(2027, 0, 1)), new Map());

    expect(i.status).toBe('finished');
    expect(i.canDeleteFuture).toBe(false);
    expect(i.canDeleteAll).toBe(true);
  });

  it('compra com todas as parcelas canceladas fica cancelada e sem estorno', () => {
    const [i] = groupInstallments(
      fourParcels().map((p) => ({ ...p, status: 'cancelled' }) as Parcel),
      TODAY,
      new Map(),
    );

    expect(i.status).toBe('cancelled');
    expect(i.refundAnchorId).toBeNull();
  });

  it('expõe a parcela do mês, as que podem ser adiantadas e as já adiantadas', () => {
    // 5ª parcela (dez) adiantada para hoje; a 3ª (15/out) é a do mês atual.
    const parcels = [...fourParcels(), parcel(5, { advancedAt: TODAY, transactionDate: TODAY })];
    const [i] = groupInstallments(parcels, TODAY, new Map());

    expect(i).toMatchObject({ currentNumber: 3, upcomingNumber: 4, upcomingDate: day(10) });
    expect(i.advanceable.map((p) => p.installmentNumber)).toEqual([4]);
    expect(i.advancedCount).toBe(1);
    expect(i.advanceBlockedReason).toBeNull();
  });

  it('parcela adiantada para antes da parcela 1 não vira a "primeira" nem a "próxima"', () => {
    // Conta: parcela 1 em 25/out (hoje é 10/out); a 4ª, com desconto, adiantada para hoje.
    const parcels = [
      parcel(4, {
        advancedAt: TODAY,
        transactionDate: TODAY,
        amount: 200,
        amountBeforeAdvance: 250,
      } as Partial<Parcel>),
      ...[1, 2, 3].map((n) => parcel(n, { transactionDate: day(8 + n, 25) })),
    ];
    const [i] = groupInstallments(parcels, TODAY, new Map());

    expect(i).toMatchObject({
      installmentAmount: 250,
      firstDate: day(9, 25),
      nextNumber: 1,
      refundAnchorId: 'p1',
    });
  });

  it('ordena em andamento antes de encerradas', () => {
    const finished = [1, 2].map((n) =>
      parcel(n, { seriesId: 's2', installmentTotal: 2, transactionDate: day(n) }),
    );
    const sorted = sortInstallments(
      groupInstallments([...finished, ...fourParcels()], TODAY, new Map()),
    );
    expect(sorted.map((i) => i.seriesId)).toEqual(['s1', 's2']);
  });
});

describe('InstallmentsService.remove', () => {
  function createService(parcels: Parcel[], locked = new Map<string, string>(), refunded = []) {
    const prisma: any = {
      transaction: {
        findMany: jest.fn().mockResolvedValue(parcels),
        groupBy: jest.fn().mockResolvedValue(refunded),
        deleteMany: jest.fn(({ where }) => Promise.resolve({ count: where.id.in.length })),
      },
      installmentPurchase: { deleteMany: jest.fn() },
      $queryRaw: jest.fn(),
    };
    // Transação interativa: o callback recebe o próprio dublê como `tx`.
    prisma.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(prisma));
    const accounts = { recalculateBalance: jest.fn() };
    const cardLedger = {
      lockReasons: jest.fn((txs: Parcel[]) =>
        Promise.resolve(new Map([...locked].filter(([id]) => txs.some((t) => t.id === id)))),
      ),
      pruneForAccount: jest.fn(),
    };
    const service = new InstallmentsService(
      prisma as any,
      accounts as any,
      {} as any,
      cardLedger as any,
    );
    jest.spyOn(service as any, 'today').mockReturnValue(TODAY);
    return { prisma, accounts, cardLedger, service };
  }

  it('apaga a compra inteira e recalcula o saldo', async () => {
    const { prisma, accounts, service } = createService(fourParcels());

    await expect(service.remove('u1', 's1', 'all')).resolves.toEqual({ deleted: 4 });
    // Parcela paga nunca sai junto (o filtro repete a trava dentro da transação).
    expect(prisma.transaction.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2', 'p3', 'p4'] }, settledAmount: 0 },
    });
    expect(accounts.recalculateBalance).toHaveBeenCalledWith('a1', prisma);
    // Sem parcelas, a compra também sai.
    expect(prisma.installmentPurchase.deleteMany).toHaveBeenCalled();
  });

  it('apaga só as parcelas de hoje em diante', async () => {
    const { prisma, service } = createService(fourParcels());

    await expect(service.remove('u1', 's1', 'future')).resolves.toEqual({ deleted: 2 });
    expect(prisma.transaction.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['p3', 'p4'] }, settledAmount: 0 },
    });
  });

  it('parcela com pagamento registrado bloqueia a exclusão', async () => {
    const parcels = fourParcels();
    (parcels[3] as any).settledAmount = 250;
    const { prisma, service } = createService(parcels);

    await expect(service.remove('u1', 's1', 'future')).rejects.toThrow('pagamento registrado');
    expect(prisma.transaction.deleteMany).not.toHaveBeenCalled();
  });

  it('não apaga nada se uma parcela atingida está travada', async () => {
    const { prisma, service } = createService(
      fourParcels(),
      new Map([['p2', 'Este lançamento está em uma fatura fechada.']]),
    );

    await expect(service.remove('u1', 's1', 'all')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.transaction.deleteMany).not.toHaveBeenCalled();
    // A trava do passado não atinge a exclusão das futuras.
    await expect(service.remove('u1', 's1', 'future')).resolves.toEqual({ deleted: 2 });
  });

  it('parcela com estorno bloqueia a exclusão', async () => {
    const { service } = createService(fourParcels(), new Map(), [{ refundOfId: 'p3' }] as any);

    await expect(service.remove('u1', 's1', 'future')).rejects.toBeInstanceOf(ConflictException);
  });

  it('sem parcelas futuras, "de hoje em diante" é um erro de uso', async () => {
    const { service } = createService(fourParcels().slice(0, 2));

    await expect(service.remove('u1', 's1', 'future')).rejects.toBeInstanceOf(BadRequestException);
  });
});

/** Só as atualizações de adiantamento (o pagamento também atualiza o liquidado). */
function advanceUpdates(prisma: any): any[] {
  return prisma.transaction.update.mock.calls
    .map(([args]: any[]) => args)
    .filter((args: any) => args.data.advancedAt);
}

describe('InstallmentsService.advance', () => {
  function createService(parcels: Parcel[]) {
    const prisma: any = {
      transaction: {
        findMany: jest.fn().mockResolvedValue(parcels),
        groupBy: jest.fn().mockResolvedValue([]),
        update: jest.fn((args) => args),
      },
      transactionSettlement: { create: jest.fn().mockResolvedValue({}) },
      account: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(),
    };
    prisma.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(prisma));
    const accounts = { recalculateBalance: jest.fn() };
    const cardLedger = {
      lockReasons: jest.fn().mockResolvedValue(new Map()),
      syncTransactions: jest.fn(),
      pruneForAccount: jest.fn(),
    };
    const service = new InstallmentsService(
      prisma as any,
      accounts as any,
      {} as any,
      cardLedger as any,
    );
    jest.spyOn(service as any, 'today').mockReturnValue(TODAY);
    return { prisma, accounts, cardLedger, service };
  }

  it('traz a última parcela para hoje e sincroniza saldo e fatura', async () => {
    const { prisma, accounts, cardLedger, service } = createService(fourParcels());

    await service.advance('u1', 's1', { count: 1 });
    expect(advanceUpdates(prisma)).toEqual([
      {
        where: { id: 'p4' },
        data: { transactionDate: TODAY, advancedAt: TODAY, advancedFromDate: day(10) },
      },
    ]);
    expect(cardLedger.syncTransactions).toHaveBeenCalledWith(['p4'], prisma);
    expect(accounts.recalculateBalance).toHaveBeenCalledWith('a1', prisma);
  });

  it('em conta comum, adiantar é pagar agora: grava o pagamento da parcela', async () => {
    const { prisma, service } = createService(fourParcels());

    await service.advance('u1', 's1', { count: 1 });
    expect(prisma.transactionSettlement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          transactionId: 'p4',
          accountId: 'a1',
          amount: 250,
          settledOn: TODAY,
          kind: 'payment',
        }),
      }),
    );
  });

  it('no cartão, a parcela vai para a fatura aberta e não é paga na hora', async () => {
    const card = fourParcels().map((p) =>
      Object.assign(p, { account: { id: 'a1', name: 'Cartão', type: 'credit_card' } }),
    );
    const { prisma, service } = createService(card);

    await service.advance('u1', 's1', { count: 1 });
    expect(prisma.transactionSettlement.create).not.toHaveBeenCalled();
  });

  it('com desconto, rateia o total entre as parcelas adiantadas', async () => {
    const { prisma, service } = createService([...fourParcels(), parcel(5)]);

    await service.advance('u1', 's1', { count: 2, amount: 400 });
    const data = advanceUpdates(prisma).map((args) => args.data);
    expect(data.map((d) => [d.amount, d.amountBeforeAdvance])).toEqual([
      [200, 250],
      [200, 250],
    ]);
  });

  it('recusa mais parcelas do que as disponíveis e desconto acima da soma', async () => {
    const { prisma, service } = createService([...fourParcels(), parcel(5)]);

    await expect(service.advance('u1', 's1', { count: 3 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.advance('u1', 's1', { count: 2, amount: 501 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('recusa desconto que zeraria alguma parcela', async () => {
    const { prisma, service } = createService([...fourParcels(), parcel(5)]);

    await expect(service.advance('u1', 's1', { count: 2, amount: 0.01 })).rejects.toThrow(
      'baixo demais',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reenvio do mesmo pedido (a cauda já mudou) não adianta nada', async () => {
    const { prisma, service } = createService([...fourParcels(), parcel(5)]);

    await expect(
      service.advance('u1', 's1', { count: 1, expectedLastNumber: 4 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await service.advance('u1', 's1', { count: 1, expectedLastNumber: 5 });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('sem parcelas futuras, explica o motivo', async () => {
    const { service } = createService(fourParcels().slice(0, 2));

    await expect(service.advance('u1', 's1', { count: 1 })).rejects.toThrow(
      'Não há parcelas futuras para adiantar.',
    );
  });
});

describe('buildInstallmentsSummary', () => {
  const card = (accountId: string, creditLimit: number | null) => ({
    accountId,
    name: accountId,
    color: null,
    creditLimit,
  });
  const remaining = (categoryId: string | null, amount: number) => ({
    categoryId,
    categoryName: categoryId,
    color: null,
    amount,
  });

  it('compara as parcelas a faturar de cada cartão com o limite dele', () => {
    const { byCard } = buildInstallmentsSummary({
      cards: [card('nubank', 1000), card('inter', 2000)],
      unbilled: [
        { accountId: 'nubank', amount: 200 },
        { accountId: 'nubank', amount: 100 },
        { accountId: 'inter', amount: 1700 },
      ],
      remaining: [],
    });

    expect(byCard.map((c) => [c.accountId, c.committed, c.percentage, c.health?.key])).toEqual([
      ['inter', 1700, 85, 'no_limite'],
      ['nubank', 300, 30, 'saudavel'],
    ]);
  });

  it('cartão sem parcelamento fica de fora', () => {
    const { byCard } = buildInstallmentsSummary({
      cards: [card('nubank', 1000), card('inter', 2000)],
      unbilled: [{ accountId: 'nubank', amount: 100 }],
      remaining: [],
    });

    expect(byCard.map((c) => c.accountId)).toEqual(['nubank']);
  });

  it('cartão sem limite cadastrado não tem percentual nem faixa', () => {
    const { byCard } = buildInstallmentsSummary({
      cards: [card('sem-limite', null)],
      unbilled: [{ accountId: 'sem-limite', amount: 500 }],
      remaining: [],
    });

    expect(byCard[0]).toMatchObject({ committed: 500, percentage: null, health: null });
  });

  it('agrupa o restante a pagar por categoria, com "Sem categoria"', () => {
    const { remaining: total, byCategory } = buildInstallmentsSummary({
      cards: [],
      unbilled: [],
      remaining: [
        remaining('eletronicos', 33.33),
        remaining('eletronicos', 33.34),
        remaining(null, 33.33),
      ],
    });

    expect(total).toBe(100);
    expect(byCategory.map((c) => [c.categoryName, c.total])).toEqual([
      ['eletronicos', 66.67],
      ['Sem categoria', 33.33],
    ]);
    expect(byCategory[0].percentage).toBeCloseTo(66.67, 2);
  });
});
