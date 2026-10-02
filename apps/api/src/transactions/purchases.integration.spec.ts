import { parseDateOnly } from '../common/date.util';
import {
  FinancialEnv,
  createFinancialEnv,
  dayFromToday,
  integration,
  key,
} from '../../test/financial-test-env';

/**
 * Item 3 da revisão do modelo pessoal (docs/adrs/0018): a compra parcelada é
 * uma operação com data e total próprios; as parcelas são o calendário de
 * cobrança. "Gastos por data da compra" e "Compromissos por vencimento" são
 * visões separadas e nunca se somam.
 */
integration('compra parcelada × calendário de cobrança (PostgreSQL)', () => {
  let env: FinancialEnv;
  let userId: string;

  beforeAll(async () => {
    env = await createFinancialEnv();
    userId = await env.createUser();
  });

  afterAll(async () => {
    if (env) await env.close();
  });

  /** Cartão com fechamento 10, vencimento 17 e controle desde 2026-01-01. */
  async function newCard() {
    const card = await env.cards.create(userId, {
      name: 'Cartão',
      closingDay: 10,
      dueDay: 17,
      creditLimit: 10000,
    });
    await env.prisma.creditCard.update({
      where: { id: card.id },
      data: { invoiceTrackingStart: parseDateOnly('2026-01-01') },
    });
    return card;
  }

  it('R$ 1.200 em 3x consumidos em setembro: R$ 1.200 em setembro na visão de gastos, 3 × R$ 400 nas faturas', async () => {
    const checking = await env.account(userId, 5000);
    const card = await newCard();
    const purchase = await env.transactions.create(userId, {
      accountId: card.accountId,
      type: 'expense',
      amount: 1200,
      description: 'Geladeira',
      transactionDate: '2026-09-05',
      recurrenceType: 'parcelado',
      installments: 3,
    });
    const scope = { cardIds: [card.id] };

    // Gastos por data da compra: R$ 1.200 em setembro, nada em outubro.
    const september = await env.dashboard.getSummary(userId, '2026-09-01', '2026-09-30', scope);
    expect(september.spending.realized).toBe(1200);
    const october = await env.dashboard.getSummary(userId, '2026-10-01', '2026-10-31', scope);
    expect(october.spending.realized).toBe(0);
    expect(
      (
        await env.transactions.summary(userId, {
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          dateBasis: 'event',
          ...scope,
        })
      ).expense,
    ).toBe(1200);

    // Compromissos por vencimento: uma parcela por mês — nunca somada à compra.
    const dueSeptember = await env.transactions.summary(userId, {
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      ...scope,
    });
    expect(dueSeptember.expense).toBe(400);

    // Calendário: três faturas consecutivas de R$ 400.
    const invoices = (await env.cards.invoices(userId, card.id)).reverse();
    expect(invoices.map((i) => [i.referenceMonth, i.charges])).toEqual([
      ['2026-09', 400],
      ['2026-10', 400],
      ['2026-11', 400],
    ]);

    // A compra tem identidade, data e total próprios.
    const installment = await env.installments.findOne(userId, purchase.seriesId!);
    expect(installment).toMatchObject({ contractAmount: 1200, remainingCommitment: 1200 });
    expect(installment.purchaseDate.toISOString().slice(0, 10)).toBe('2026-09-05');
    expect(installment.schedule.map((p) => [p.installmentNumber, p.amount, p.dueDate])).toEqual([
      [1, 400, '2026-09-05'],
      [2, 400, '2026-10-05'],
      [3, 400, '2026-11-05'],
    ]);

    // Comprar no cartão não mexe no saldo bancário.
    expect(await env.balance(checking)).toBe(5000);

    // Pagar R$ 400 (a primeira fatura) deixa R$ 800 de compromisso.
    await env.payments.pay(userId, card.id, invoices[0].id, {
      sourceAccountId: checking,
      amount: 400,
      paymentDate: dayFromToday(0),
      idempotencyKey: key(),
    });
    expect(await env.balance(checking)).toBe(4600);
    expect((await env.installments.findOne(userId, purchase.seriesId!)).remainingCommitment).toBe(
      800,
    );
    expect((await env.cards.findOne(userId, card.id)).totalDebt).toBe(800);
    // O pagamento da fatura não é gasto: a visão de setembro não muda.
    expect(
      (await env.dashboard.getSummary(userId, '2026-09-01', '2026-09-30', scope)).spending.realized,
    ).toBe(1200);
  });

  it('a soma das parcelas preserva o total, inclusive com arredondamento', async () => {
    const checking = await env.account(userId, 0);
    const purchase = await env.transactions.create(userId, {
      accountId: checking,
      type: 'expense',
      amount: 1000,
      description: 'Curso',
      transactionDate: dayFromToday(1),
      recurrenceType: 'parcelado',
      installments: 3,
    });
    const rows = await env.prisma.transaction.findMany({
      where: { seriesId: purchase.seriesId },
      orderBy: { installmentNumber: 'asc' },
    });
    expect(rows.map((r) => Number(r.amount))).toEqual([333.33, 333.33, 333.34]);
    const stored = await env.prisma.installmentPurchase.findUniqueOrThrow({
      where: { id: purchase.seriesId! },
    });
    expect(Number(stored.totalAmount)).toBe(1000);
    expect(rows.every((r) => r.purchaseId === stored.id)).toBe(true);
  });

  it('crediário em conta comum: o saldo só muda quando a parcela é paga', async () => {
    const checking = await env.account(userId, 1000);
    const purchase = await env.transactions.create(userId, {
      accountId: checking,
      type: 'expense',
      amount: 300,
      description: 'Sofá',
      transactionDate: dayFromToday(-1),
      recurrenceType: 'parcelado',
      installments: 3,
    });
    expect(await env.balance(checking)).toBe(1000);
    expect((await env.installments.findOne(userId, purchase.seriesId!)).remainingCommitment).toBe(
      300,
    );

    await env.settlements.settle(userId, purchase.id, {
      date: dayFromToday(0),
      idempotencyKey: key(),
    });
    expect(await env.balance(checking)).toBe(900);
    expect((await env.installments.findOne(userId, purchase.seriesId!)).remainingCommitment).toBe(
      200,
    );
  });
});
