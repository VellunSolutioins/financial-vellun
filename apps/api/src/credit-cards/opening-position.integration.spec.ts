import {
  FinancialEnv,
  createFinancialEnv,
  dayFromToday,
  integration,
  key,
} from '../../test/financial-test-env';

/**
 * Item 6 da revisão do modelo pessoal (docs/adrs/0018): posição inicial do
 * cartão, cartões arquivados e cartões sem configuração.
 */
integration('cartão: posição inicial e cartões arquivados (PostgreSQL)', () => {
  let env: FinancialEnv;
  let userId: string;
  let checking: string;

  beforeAll(async () => {
    env = await createFinancialEnv();
    userId = await env.createUser();
    checking = await env.account(userId, 5000);
  });

  afterAll(async () => {
    if (env) await env.close();
  });

  it('fatura anterior de R$ 800 não paga vira dívida pagável, sem criar despesa', async () => {
    const card = await env.cards.create(userId, {
      name: 'Cartão novo',
      closingDay: 10,
      dueDay: 17,
      creditLimit: 3000,
    });
    // Sem posição inicial, o app não presume que a fatura anterior foi paga:
    // simplesmente não sabe dela.
    const view = await env.cards.setOpeningPosition(userId, card.id, {
      previousInvoiceAmount: 800,
    });
    expect(view).toMatchObject({
      totalDebt: 800,
      openingPosition: { previousInvoiceAmount: 800, credit: 0 },
    });

    // Não é despesa: nem no mês de hoje, nem no da fatura anterior.
    const summary = await env.transactions.summary(userId, {});
    expect(summary.expense).toBe(0);
    const dashboard = await env.dashboard.getSummary(userId);
    expect(dashboard.spending.realized).toBe(0);
    expect(dashboard.upcomingBills).toEqual([
      expect.objectContaining({ kind: 'invoice', amount: 800 }),
    ]);

    // Pagável como qualquer fatura.
    const [opening] = (await env.cards.invoices(userId, card.id)).filter((i) => i.isOpening);
    expect(opening).toMatchObject({ openingDebt: 800, remaining: 800 });
    await env.payments.pay(userId, card.id, opening.id, {
      sourceAccountId: checking,
      amount: 300,
      paymentDate: dayFromToday(0),
      idempotencyKey: key(),
    });
    expect((await env.cards.findOne(userId, card.id)).totalDebt).toBe(500);

    // Importar o histórico depois não duplica a posição inicial: compras
    // anteriores ao controle ficam fora das faturas e da dívida.
    await env.transactions.create(userId, {
      accountId: card.accountId,
      type: 'expense',
      amount: 450,
      description: 'Compra antiga',
      transactionDate: dayFromToday(-75),
    });
    expect((await env.cards.findOne(userId, card.id)).totalDebt).toBe(500);

    // Substituir a posição cancela a anterior (o histórico fica) e grava a nova.
    const replaced = await env.cards.setOpeningPosition(userId, card.id, {
      previousInvoiceAmount: 800,
      credit: 50,
    });
    expect(replaced).toMatchObject({ totalDebt: 450, openingPosition: { credit: 50 } });
    expect(
      await env.prisma.transaction.count({
        where: { accountId: card.accountId, type: 'opening_debt', status: 'cancelled' },
      }),
    ).toBe(1);
  });

  it('arquivar impede compras, mas preserva a dívida nos totais e permite pagar e estornar', async () => {
    const card = await env.cards.create(userId, {
      name: 'Cartão a arquivar',
      closingDay: 10,
      dueDay: 17,
      creditLimit: 2000,
    });
    const purchase = await env.transactions.create(userId, {
      accountId: card.accountId,
      type: 'expense',
      amount: 400,
      description: 'Compra',
      transactionDate: dayFromToday(0),
    });
    const before = await env.cards.summary(userId);
    await env.cards.remove(userId, card.id);
    const after = await env.cards.summary(userId);

    // A dívida continua; o limite deixa de contar.
    expect(after.totalDebt).toBe(before.totalDebt);
    expect(after.totalLimit).toBe(before.totalLimit - 2000);
    expect(after.archivedWithDebtCount).toBe(1);

    await expect(
      env.transactions.create(userId, {
        accountId: card.accountId,
        type: 'expense',
        amount: 10,
        description: 'Nova',
        transactionDate: dayFromToday(0),
      }),
    ).rejects.toMatchObject({ status: 400 });

    const invoiceId = (
      await env.prisma.transaction.findUniqueOrThrow({ where: { id: purchase.id } })
    ).invoiceId!;
    await env.payments.pay(userId, card.id, invoiceId, {
      sourceAccountId: checking,
      amount: 100,
      paymentDate: dayFromToday(0),
      idempotencyKey: key(),
    });
    await env.transactions.refund(userId, purchase.id, { amount: 50, date: dayFromToday(0) });
    expect((await env.cards.findOne(userId, card.id)).totalDebt).toBe(250);
  });

  it('cartão sem configuração indica informação incompleta, sem assumir dívida zero', async () => {
    const card = await env.cards.create(userId, {
      name: 'Cartão legado',
      closingDay: 10,
      dueDay: 17,
    });
    await env.prisma.creditCard.update({
      where: { id: card.id },
      data: { closingDay: null, dueDay: null, invoiceTrackingStart: null },
    });

    expect(await env.cards.findOne(userId, card.id)).toMatchObject({
      needsSetup: true,
      debtKnown: false,
      totalDebt: null,
    });
    const summary = await env.cards.summary(userId);
    expect(summary.incompleteCards).toBe(1);
  });
});
