import { advanceState, distributeAdvance, type AdvanceCandidate } from './installment-advance';

const TODAY = new Date(Date.UTC(2026, 9, 10));
const month = (m: number) => new Date(Date.UTC(2026, m, 5));

/**
 * Compra em 10x no cartão, parcela n na fatura que começa no mês 7 + n
 * (hoje = 10/out): a 3/10 está na fatura aberta (começou em 05/out).
 */
const cardParcel = (n: number, overrides: Partial<AdvanceCandidate> = {}): AdvanceCandidate => ({
  id: `p${n}`,
  status: 'confirmed',
  installmentNumber: n,
  transactionDate: month(7 + n),
  amount: 100,
  advancedAt: null,
  invoice: { periodStart: month(6 + n) },
  ...overrides,
});
const tenParcels = () => Array.from({ length: 10 }, (_, i) => cardParcel(i + 1));
const ids = (list: AdvanceCandidate[]) => list.map((p) => p.id);
const advanceableParcels = (
  parcels: AdvanceCandidate[],
  today: Date,
  blocked: Map<string, string>,
) => advanceState(parcels, today, blocked).advanceable;
const advanceBlockedReason = (
  parcels: AdvanceCandidate[],
  today: Date,
  blocked: Map<string, string>,
) => advanceState(parcels, today, blocked).blockedReason;
const installmentProgress = (parcels: AdvanceCandidate[], today: Date) => {
  const { currentNumber, upcomingNumber, upcomingDate } = advanceState(parcels, today, new Map());
  return { currentNumber, upcomingNumber, upcomingDate };
};

describe('advanceableParcels', () => {
  it('na 3/10, as 7 parcelas seguintes podem ser adiantadas, da última para a primeira', () => {
    expect(ids(advanceableParcels(tenParcels(), TODAY, new Map()))).toEqual([
      'p10',
      'p9',
      'p8',
      'p7',
      'p6',
      'p5',
      'p4',
    ]);
  });

  it('parcela travada corta a cauda: só as posteriores a ela entram', () => {
    const blocked = new Map([['p6', 'A fatura deste lançamento já tem pagamento.']]);
    expect(ids(advanceableParcels(tenParcels(), TODAY, blocked))).toEqual([
      'p10',
      'p9',
      'p8',
      'p7',
    ]);
  });

  it('pula as já adiantadas e as canceladas', () => {
    const parcels = tenParcels().map((p) =>
      p.installmentNumber! >= 9
        ? { ...p, advancedAt: TODAY, transactionDate: TODAY, invoice: { periodStart: month(9) } }
        : p.installmentNumber === 8
          ? { ...p, status: 'cancelled' }
          : p,
    );
    expect(ids(advanceableParcels(parcels, TODAY, new Map()))).toEqual(['p7', 'p6', 'p5', 'p4']);
  });

  it('sem fatura (conta comum), vale o mês: a parcela de mais tarde neste mês não é futura', () => {
    const parcels = [1, 2, 3, 4].map((n) =>
      cardParcel(n, {
        invoice: null,
        transactionDate: n === 3 ? new Date(Date.UTC(2026, 9, 28)) : month(7 + n),
      }),
    );
    expect(ids(advanceableParcels(parcels, TODAY, new Map()))).toEqual(['p4']);
  });
});

describe('installmentProgress', () => {
  it('no cartão, a parcela atual é a da fatura aberta', () => {
    expect(installmentProgress(tenParcels(), TODAY)).toEqual({
      currentNumber: 3,
      upcomingNumber: 4,
      upcomingDate: month(11),
    });
  });

  it('adiantadas não contam como atual nem como próxima', () => {
    const parcels = tenParcels().map((p) =>
      p.installmentNumber! >= 7
        ? { ...p, advancedAt: TODAY, transactionDate: TODAY, invoice: { periodStart: month(9) } }
        : p,
    );
    expect(installmentProgress(parcels, TODAY)).toMatchObject({
      currentNumber: 3,
      upcomingNumber: 4,
    });
  });

  it('compra que ainda não começou está na parcela 0', () => {
    const later = tenParcels().map((p) => ({ ...p, invoice: { periodStart: month(20) } }));
    expect(installmentProgress(later, TODAY)).toMatchObject({
      currentNumber: 0,
      upcomingNumber: 1,
    });
  });

  it('compra quitada não tem próxima', () => {
    const past = tenParcels().map((p) => ({ ...p, invoice: { periodStart: month(0) } }));
    expect(installmentProgress(past, TODAY)).toEqual({
      currentNumber: 10,
      upcomingNumber: null,
      upcomingDate: null,
    });
  });
});

describe('advanceBlockedReason', () => {
  it('é nulo quando há o que adiantar', () => {
    expect(advanceBlockedReason(tenParcels(), TODAY, new Map())).toBeNull();
  });

  it('traz a trava da última parcela futura', () => {
    const blocked = new Map([['p10', 'Esta compra tem estornos.']]);
    expect(advanceBlockedReason(tenParcels(), TODAY, blocked)).toBe('Esta compra tem estornos.');
  });

  it('sem parcelas futuras, diz isso — mesmo que a última esteja numa fatura fechada', () => {
    const parcels = tenParcels().slice(0, 3);
    const blocked = new Map([['p2', 'Este lançamento está em uma fatura fechada.']]);
    expect(advanceBlockedReason(parcels, TODAY, blocked)).toBe(
      'Não há parcelas futuras para adiantar.',
    );
  });
});

describe('distributeAdvance', () => {
  it('rateia proporcionalmente e soma exatamente o alvo', () => {
    const shares = distributeAdvance([10000, 10000, 10000], 28000);
    expect(shares).toEqual([9333, 9333, 9334]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(28000);
  });

  it('respeita parcelas de valores diferentes', () => {
    expect(distributeAdvance([3333, 3334], 6000)).toEqual([2999, 3001]);
  });

  it('sem desconto, devolve os mesmos valores', () => {
    expect(distributeAdvance([3333, 3333, 3334], 10000)).toEqual([3333, 3333, 3334]);
  });
});
