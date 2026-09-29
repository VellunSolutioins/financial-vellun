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
    const prisma = {
      transaction: {
        findMany: jest.fn().mockResolvedValue(parcels),
        groupBy: jest.fn().mockResolvedValue(refunded),
        deleteMany: jest.fn(({ where }) => Promise.resolve({ count: where.id.in.length })),
      },
    };
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
    expect(prisma.transaction.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2', 'p3', 'p4'] } },
    });
    expect(accounts.recalculateBalance).toHaveBeenCalledWith('a1');
  });

  it('apaga só as parcelas de hoje em diante', async () => {
    const { prisma, service } = createService(fourParcels());

    await expect(service.remove('u1', 's1', 'future')).resolves.toEqual({ deleted: 2 });
    expect(prisma.transaction.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['p3', 'p4'] } },
    });
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
