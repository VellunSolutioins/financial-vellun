import { fromBusinessSummary, fromPersonalSummary } from './whatsapp-summary';

const personal = {
  period: { start: '2026-11-01', end: '2026-11-30' },
  cashBalance: 1500,
  spending: { realized: 820.5, forecast: 120, byNature: {} },
  income: { received: 3000, pending: 200 },
  result: { value: 2179.5, percentOfIncome: 72.65 },
  commitments: {
    horizon: '2026-11-30',
    overdueBills: 100,
    overdueForecast: 10,
    billsToHorizon: 300,
    forecastToHorizon: 40,
    receivableToHorizon: 200,
    invoicesOverdue: 0,
    invoicesToHorizon: 450.25,
  },
  cards: { totalDebt: 980 },
  expensesByCategory: [
    { categoryName: 'Mercado', total: 500 },
    { categoryName: 'Transporte', total: 320.5 },
    { categoryName: 'Estornada', total: -10 },
  ],
  upcomingBills: [
    {
      kind: 'transaction',
      description: '',
      category: { name: 'Luz' },
      remaining: 120,
      transactionDate: new Date('2026-11-20T00:00:00Z'),
      isOverdue: false,
    },
    {
      kind: 'invoice',
      description: 'Fatura Nubank',
      category: null,
      remaining: 450.25,
      transactionDate: new Date('2026-11-25T00:00:00Z'),
      isOverdue: false,
    },
  ],
} as any;

describe('fromPersonalSummary', () => {
  it('lista as receitas previstas à parte das contas a pagar', () => {
    const receivables = [
      {
        description: 'pagamento Kazap',
        category: { name: 'Salário' },
        amount: '6825',
        settledAmount: '0',
        transactionDate: new Date('2026-12-01T12:00:00Z'),
      },
      {
        description: '',
        category: { name: 'Freela' },
        amount: '500',
        settledAmount: '200',
        transactionDate: new Date('2026-11-15T12:00:00Z'),
      },
    ] as any;

    const summary = fromPersonalSummary(personal, receivables, '2026-11-21');

    expect(summary.upcomingIncome).toEqual([
      { description: 'pagamento Kazap', remaining: 6825, dueDate: '2026-12-01', isOverdue: false },
      { description: 'Freela', remaining: 300, dueDate: '2026-11-15', isOverdue: true },
    ]);
    expect(summary.upcoming.map((item) => item.description)).not.toContain('pagamento Kazap');
  });

  it('usa os mesmos números do dashboard pessoal', () => {
    const summary = fromPersonalSummary(personal, [], '2026-11-21');

    expect(summary).toMatchObject({
      profileType: 'individual',
      period: { start: '2026-11-01', end: '2026-11-30' },
      cashBalance: 1500,
      spent: 820.5,
      spentForecast: 120,
      received: 3000,
      toReceive: 200,
      result: 2179.5,
      cardsDebt: 980,
    });
  });

  it('soma contas, previsões e faturas no que há a pagar até o fim do mês', () => {
    const { commitments } = fromPersonalSummary(personal, [], '2026-11-21');

    expect(commitments).toEqual({
      until: '2026-11-30',
      toPay: 900.25,
      overdue: 110,
      toReceive: 200,
    });
  });

  it('deixa de fora categorias sem gasto e dá nome à conta sem descrição', () => {
    const summary = fromPersonalSummary(personal, [], '2026-11-21');

    expect(summary.byCategory).toEqual([
      { name: 'Mercado', total: 500 },
      { name: 'Transporte', total: 320.5 },
    ]);
    expect(summary.byCategoryComplete).toBe(true);
    expect(summary.upcoming).toEqual([
      { description: 'Luz', remaining: 120, dueDate: '2026-11-20', isOverdue: false, kind: 'bill' },
      {
        description: 'Fatura Nubank',
        remaining: 450.25,
        dueDate: '2026-11-25',
        isOverdue: false,
        kind: 'invoice',
      },
    ]);
  });
});

describe('fromBusinessSummary', () => {
  const business = {
    totalBalance: 10000,
    totalIncome: 8000,
    totalExpense: 5000.4,
    netResult: 2999.6,
    topExpenseCategories: [{ categoryName: 'Fornecedores', total: 3000 }],
    accountsReceivable: {
      total: 1200,
      count: 1,
      items: [
        {
          description: 'Cliente',
          amount: '1200',
          settledAmount: '0',
          transactionDate: new Date('2026-11-25T00:00:00Z'),
          category: null,
        },
      ],
    },
    accountsPayable: {
      total: 700,
      count: 2,
      items: [
        {
          description: 'Aluguel',
          amount: '500',
          settledAmount: '100',
          transactionDate: new Date('2026-11-10T00:00:00Z'),
          category: null,
        },
        {
          description: 'Internet',
          amount: '300',
          settledAmount: '0',
          transactionDate: new Date('2026-11-28T00:00:00Z'),
          category: null,
        },
      ],
    },
  } as any;

  it('usa os números do dashboard empresarial e o que falta de cada conta', () => {
    const summary = fromBusinessSummary(
      business,
      { start: '2026-11-01', end: '2026-11-30' },
      '2026-11-21',
    );

    expect(summary).toMatchObject({
      profileType: 'business',
      cashBalance: 10000,
      spent: 5000.4,
      spentForecast: null,
      received: 8000,
      toReceive: 1200,
      result: 2999.6,
      cardsDebt: null,
      upcomingIncome: [
        { description: 'Cliente', remaining: 1200, dueDate: '2026-11-25', isOverdue: false },
      ],
      byCategoryComplete: false,
      commitments: { until: null, toPay: 700, overdue: null, toReceive: 1200 },
    });
    expect(summary.upcoming).toEqual([
      {
        description: 'Aluguel',
        remaining: 400,
        dueDate: '2026-11-10',
        isOverdue: true,
        kind: 'bill',
      },
      {
        description: 'Internet',
        remaining: 300,
        dueDate: '2026-11-28',
        isOverdue: false,
        kind: 'bill',
      },
    ]);
  });
});
