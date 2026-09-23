import {
  buildFixedSummary,
  groupRecurrences,
  monthlyEquivalent,
  withDay,
  type Occurrence,
} from './recurrences.service';

const occurrence = (overrides: Partial<Occurrence>): Occurrence =>
  ({
    id: Math.random().toString(),
    seriesId: 's1',
    description: 'Aluguel',
    type: 'expense',
    amount: 1800,
    status: 'confirmed',
    recurrenceType: 'fixo',
    recurrenceFrequency: 'monthly',
    transactionDate: new Date(Date.UTC(2026, 9, 1, 12)),
    accountId: 'a1',
    categoryId: 'c1',
    account: { id: 'a1', name: 'Conta' },
    category: { id: 'c1', name: 'Moradia', color: null },
    ...overrides,
  }) as unknown as Occurrence;

const row = (type: string, total: number, categoryId: string | null = null, name?: string) => ({
  type,
  categoryId,
  categoryName: name ?? null,
  color: null,
  total,
});

describe('groupRecurrences', () => {
  it('agrupa as ocorrências por série e usa a próxima confirmada', () => {
    const [recurrence] = groupRecurrences([
      occurrence({ status: 'cancelled', amount: 1 as any }),
      occurrence({ transactionDate: new Date(Date.UTC(2026, 10, 1, 12)) }),
      occurrence({ transactionDate: new Date(Date.UTC(2026, 11, 1, 12)) }),
    ]);

    expect(recurrence.isActive).toBe(true);
    expect(recurrence.remaining).toBe(2);
    expect(recurrence.amount).toBe(1800);
    expect(recurrence.nextDate.toISOString().slice(0, 10)).toBe('2026-11-01');
  });

  it('série com todas as futuras canceladas está pausada', () => {
    const [recurrence] = groupRecurrences([
      occurrence({ status: 'cancelled' }),
      occurrence({ status: 'cancelled' }),
    ]);

    expect(recurrence.isActive).toBe(false);
    expect(recurrence.remaining).toBe(0);
  });

  it('dia de vencimento é o maior dia (31 vira 30 nos meses curtos)', () => {
    const [recurrence] = groupRecurrences([
      occurrence({ transactionDate: new Date(Date.UTC(2026, 10, 30, 12)) }),
      occurrence({ transactionDate: new Date(Date.UTC(2026, 11, 31, 12)) }),
    ]);

    expect(recurrence.dueDay).toBe(31);
  });

  it('separa séries diferentes', () => {
    expect(
      groupRecurrences([occurrence({ seriesId: 's1' }), occurrence({ seriesId: 's2' })]),
    ).toHaveLength(2);
  });
});

describe('monthlyEquivalent', () => {
  it('converte cada frequência para o valor mensal', () => {
    expect(monthlyEquivalent({ amount: 1200, frequency: 'monthly' })).toBe(1200);
    expect(monthlyEquivalent({ amount: 1200, frequency: 'bimonthly' })).toBe(600);
    expect(monthlyEquivalent({ amount: 1200, frequency: 'semiannual' })).toBe(200);
    expect(monthlyEquivalent({ amount: 1200, frequency: 'annual' })).toBe(100);
  });
});

describe('buildFixedSummary', () => {
  it('calcula o comprometido sobre a receita fixa e a faixa de saúde', () => {
    const summary = buildFixedSummary([row('income', 4000), row('expense', 1800, 'c1', 'Moradia')]);

    expect(summary.committed).toBe(1800);
    expect(summary.income).toBe(4000);
    expect(summary.percentage).toBe(45);
    expect(summary.health).toEqual({ key: 'saudavel', label: 'Saudável' });
  });

  it('soma recorrências da mesma categoria e ordena da maior para a menor', () => {
    const summary = buildFixedSummary([
      row('income', 1000),
      row('expense', 100, null),
      row('expense', 200, 'c1', 'Moradia'),
      row('expense', 100, 'c1', 'Moradia'),
    ]);

    expect(summary.byCategory.map((c) => [c.categoryName, c.total, c.percentage])).toEqual([
      ['Moradia', 300, 75],
      ['Sem categoria', 100, 25],
    ]);
  });

  it('acima de 70% é alto risco', () => {
    expect(buildFixedSummary([row('income', 100), row('expense', 71)]).health.key).toBe(
      'alto_risco',
    );
  });

  it('sem receita fixa não calcula percentual', () => {
    const summary = buildFixedSummary([row('expense', 500)]);

    expect(summary.percentage).toBe(0);
    expect(summary.health.key).toBe('sem_receita');
  });
});

describe('withDay', () => {
  it('troca o dia e limita ao último dia do mês', () => {
    const feb = new Date(Date.UTC(2027, 1, 10, 12));
    expect(withDay(feb, 5).toISOString().slice(0, 10)).toBe('2027-02-05');
    expect(withDay(feb, 31).toISOString().slice(0, 10)).toBe('2027-02-28');
  });
});
