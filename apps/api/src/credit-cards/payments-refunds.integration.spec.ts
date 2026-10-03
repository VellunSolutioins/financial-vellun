import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { dateOnlyString, parseDateOnly, todaySaoPaulo } from '../common/date.util';
import { CreditCardsService } from './credit-cards.service';
import { CardPaymentsService } from './card-payments.service';

const databaseUrl = process.env.SELECTED_FEATURES_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('pagamentos de fatura e estornos (PostgreSQL)', () => {
  let prisma: PrismaService;
  let accounts: AccountsService;
  let transactions: TransactionsService;
  let cards: CreditCardsService;
  let payments: CardPaymentsService;
  let dashboard: DashboardService;
  let userId: string;
  let otherId: string;
  let foodId: string;
  const today = dateOnlyString(todaySaoPaulo());
  const month = today.slice(0, 7);
  const monthEnd = `${month}-${new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate()}`;

  const newAccount = async (initialBalance: number) =>
    (
      await accounts.create(userId, {
        name: `Conta ${randomUUID().slice(0, 4)}`,
        type: 'checking',
        initialBalance,
      })
    ).id;

  const balance = async (accountId: string) =>
    Number((await accounts.findOne(userId, accountId)).currentBalance);

  /** Cartão com fechamento 10 / vencimento 17 e controle desde 2026-01-01. */
  async function newCard() {
    const card = await cards.create(userId, {
      name: `Cartão ${randomUUID().slice(0, 4)}`,
      closingDay: 10,
      dueDay: 17,
      creditLimit: 5000,
    });
    await prisma.creditCard.update({
      where: { id: card.id },
      data: { invoiceTrackingStart: parseDateOnly('2026-01-01') },
    });
    return card;
  }

  const buy = (accountId: string, amount: number, date: string, extra = {}) =>
    transactions.create(userId, {
      accountId,
      categoryId: foodId,
      type: 'expense',
      amount,
      description: 'Compra',
      transactionDate: date,
      ...extra,
    });

  const invoiceIdOf = async (transactionId: string) =>
    (await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })).invoiceId!;

  const invoiceView = async (cardId: string, invoiceId: string) =>
    cards.invoice(userId, cardId, invoiceId);

  const pay = (
    cardId: string,
    invoiceId: string,
    sourceAccountId: string,
    amount: number,
    key = randomUUID(),
  ) =>
    payments.pay(userId, cardId, invoiceId, {
      sourceAccountId,
      amount,
      paymentDate: today,
      idempotencyKey: key,
    });

  const foodExpense = async (periodStart: string, periodEnd: string) => {
    const summary = await transactions.summary(userId, { periodStart, periodEnd });
    return {
      income: summary.income,
      expense: summary.expense,
      food:
        summary.byCategory.find((c) => c.categoryId === foodId && c.type === 'expense')?.total ?? 0,
    };
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !url.pathname.endsWith('_validation')
    ) {
      throw new Error('Use a local database with a name ending in _validation');
    }
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl } } });
    await prisma.$connect();
    accounts = new AccountsService(prisma);
    transactions = new TransactionsService(prisma, accounts);
    cards = new CreditCardsService(prisma);
    payments = new CardPaymentsService(prisma, accounts);
    dashboard = new DashboardService(prisma);
    [userId, otherId] = (
      await Promise.all(
        [0, 1].map(() =>
          prisma.user.create({
            data: {
              name: 'Payments',
              email: `${randomUUID()}@example.test`,
              passwordHash: 'not-a-login',
              profileType: 'individual',
            },
          }),
        ),
      )
    ).map((u) => u.id);
    foodId = (
      await prisma.category.create({
        data: { userId, name: 'Alimentação', type: 'expense', profileType: 'individual' },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await prisma.$disconnect();
  });

  it('exemplo do plano: compra 100 e pagamento 100 — despesa continua 100, sem receita', async () => {
    const checking = await newAccount(1000);
    const card = await newCard();
    const purchase = await buy(card.accountId, 100, '2026-02-05');
    const invoiceId = await invoiceIdOf(purchase.id);

    expect((await foodExpense('2026-02-01', '2026-02-28')).food).toBe(100);
    expect((await cards.findOne(userId, card.id)).totalDebt).toBe(100);

    const payment = await pay(card.id, invoiceId, checking, 100);
    expect(payment).toMatchObject({ amount: 100, status: 'active' });

    expect(await balance(checking)).toBe(900);
    const view = await cards.findOne(userId, card.id);
    expect(view.totalDebt).toBe(0);
    expect(view.credit).toBe(0);
    const invoice = await invoiceView(card.id, invoiceId);
    expect(invoice).toMatchObject({ paymentStatus: 'paid', remaining: 0, payments: 100 });
    expect(invoice.paymentRecords).toHaveLength(1);

    // Despesa por categoria continua 100 no mês da compra.
    expect(await foodExpense('2026-02-01', '2026-02-28')).toEqual({
      income: 0,
      expense: 100,
      food: 100,
    });
    // O pagamento não é receita nem despesa no mês em que foi feito.
    const summary = await transactions.summary(userId, {
      periodStart: `${month}-01`,
      periodEnd: monthEnd,
      accountIds: [checking],
    });
    expect(summary).toMatchObject({ income: 0, expense: 0 });
    const legs = await prisma.transaction.findMany({ where: { cardPaymentId: payment.id } });
    expect(legs.map((l) => [l.type, l.transferDirection]).sort()).toEqual([
      ['transfer', 'in'],
      ['transfer', 'out'],
    ]);
  });

  it('parcial, múltiplo, de contas diferentes, repetido, acima do restante e revertido', async () => {
    const a = await newAccount(1000);
    const b = await newAccount(500);
    const card = await newCard();
    const purchase = await buy(card.accountId, 300, '2026-03-05');
    const invoiceId = await invoiceIdOf(purchase.id);

    const key = randomUUID();
    const first = await pay(card.id, invoiceId, a, 100, key);
    const repeated = await pay(card.id, invoiceId, a, 100, key);
    expect(repeated).toMatchObject({ id: first.id, idempotent: true });
    expect(await balance(a)).toBe(900);
    expect(await prisma.cardPayment.count({ where: { idempotencyKey: key } })).toBe(1);
    expect((await invoiceView(card.id, invoiceId)).paymentStatus).toBe('partial');

    await pay(card.id, invoiceId, b, 150);
    expect(await balance(b)).toBe(350);
    expect((await invoiceView(card.id, invoiceId)).remaining).toBe(50);

    const over = await pay(card.id, invoiceId, a, 80);
    let invoice = await invoiceView(card.id, invoiceId);
    // O restante nunca fica negativo: o excedente é crédito (`surplus`), e sem
    // outra fatura onde aplicá-lo, fica como saldo credor (docs/adrs/0018).
    expect(invoice).toMatchObject({
      paymentStatus: 'credit',
      remaining: 0,
      surplus: 30,
      unappliedSurplus: 30,
    });
    let view = await cards.findOne(userId, card.id);
    expect(view).toMatchObject({ totalDebt: 0, credit: 30 });

    await payments.reverse(userId, card.id, invoiceId, over.id);
    await payments.reverse(userId, card.id, invoiceId, over.id); // idempotente
    expect(await balance(a)).toBe(900);
    invoice = await invoiceView(card.id, invoiceId);
    expect(invoice).toMatchObject({ paymentStatus: 'partial', remaining: 50 });
    expect(invoice.paymentRecords.map((p) => p.status)).toEqual(['active', 'active', 'reversed']);
    view = await cards.findOne(userId, card.id);
    expect(view).toMatchObject({ totalDebt: 50, credit: 0 });

    // Conta de cartão não é origem; data futura não vale.
    await expect(pay(card.id, invoiceId, card.accountId, 10)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      payments.pay(userId, card.id, invoiceId, {
        sourceAccountId: a,
        amount: 10,
        paymentDate: '2099-01-01',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('estorno total e parcial no cartão reduz a dívida e a despesa da categoria', async () => {
    const card = await newCard();
    const purchase = await buy(card.accountId, 200, '2026-04-05');

    const { refunds } = await transactions.refund(userId, purchase.id, { amount: 50, date: today });
    expect(refunds[0]).toMatchObject({
      type: 'refund',
      categoryId: foodId,
      refundOfId: purchase.id,
    });
    // Cai na fatura aberta hoje.
    const view = await cards.findOne(userId, card.id);
    expect(refunds[0].id).toBeDefined();
    expect(await invoiceIdOf(refunds[0].id)).toBe(view.currentInvoiceId);
    expect(view.totalDebt).toBe(150);

    expect((await foodExpense(`${month}-01`, monthEnd)).food).toBe(-50);
    expect((await foodExpense('2026-04-01', '2026-04-30')).food).toBe(200);

    await expect(
      transactions.refund(userId, purchase.id, { amount: 150.01, date: today }),
    ).rejects.toMatchObject({ status: 400 });
    await transactions.refund(userId, purchase.id, { amount: 150, date: today });
    expect((await cards.findOne(userId, card.id)).totalDebt).toBe(0);

    // Compra estornada não se cancela nem se exclui.
    await expect(transactions.remove(userId, purchase.id)).rejects.toMatchObject({ status: 409 });
  });

  it('estorno com data futura é recusado e não cria lançamento', async () => {
    const card = await newCard();
    const purchase = await buy(card.accountId, 90, today, {
      recurrenceType: 'parcelado',
      installments: 3,
    });

    await expect(
      transactions.refund(userId, purchase.id, { amount: 10, date: '2099-01-01' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      transactions.refund(userId, purchase.id, { date: '2099-01-01', scope: 'series' }),
    ).rejects.toMatchObject({ status: 400 });

    expect(await prisma.transaction.count({ where: { refundOfId: purchase.id } })).toBe(0);
    const series = await prisma.transaction.findMany({ where: { seriesId: purchase.seriesId } });
    expect(series.every((t) => t.status === 'confirmed')).toBe(true);
  });

  it('em conta comum, estorno é entrada de saldo, não receita', async () => {
    const checking = await newAccount(1000);
    const purchase = await buy(checking, 80, '2026-05-10');
    await transactions.refund(userId, purchase.id, { amount: 30, date: '2026-05-12' });

    expect(await balance(checking)).toBe(950);
    expect(await foodExpense('2026-05-01', '2026-05-31')).toEqual({
      income: 0,
      expense: 50,
      food: 50,
    });
    const dash = await dashboard.getSummary(userId, '2026-05-01', '2026-05-31', {
      accountIds: [checking],
    });
    expect(dash).toMatchObject({ income: { received: 0 }, spending: { realized: 50 } });
  });

  it('estorno de parcelado: cancela as não faturadas e estorna as faturadas', async () => {
    const checking = await newAccount(1000);
    const card = await newCard();
    const first = await buy(card.accountId, 90, today, {
      recurrenceType: 'parcelado',
      installments: 3,
    });
    const currentInvoice = await invoiceIdOf(first.id);
    // Pagamento antecipado trava a parcela 1 (fatura com pagamento ativo).
    await pay(card.id, currentInvoice, checking, 10);

    const result = await transactions.refund(userId, first.id, { date: today, scope: 'series' });
    expect(result.refunds.map((r) => Number(r.amount))).toEqual([30]);
    expect(result.cancelled).toHaveLength(2);

    const series = await prisma.transaction.findMany({
      where: { seriesId: first.seriesId },
      orderBy: { installmentNumber: 'asc' },
    });
    expect(series.map((t) => t.status)).toEqual(['confirmed', 'cancelled', 'cancelled']);
    expect(series.slice(1).map((t) => t.invoiceId)).toEqual([null, null]);
    const view = await cards.findOne(userId, card.id);
    expect(view).toMatchObject({ totalDebt: 0, credit: 10, futureInstallments: 0 });
  });

  it('fatura fechada ou paga trava valor e data, não descrição; pernas de pagamento só via reversão', async () => {
    const checking = await newAccount(1000);
    const card = await newCard();
    const closed = await buy(card.accountId, 40, '2026-06-05');

    await expect(transactions.update(userId, closed.id, { amount: 41 })).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      transactions.update(userId, closed.id, { transactionDate: '2026-06-06' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(transactions.remove(userId, closed.id)).rejects.toMatchObject({ status: 409 });
    await expect(
      transactions.update(userId, closed.id, { description: 'Mercado', amount: 40 }),
    ).resolves.toMatchObject({ description: 'Mercado' });

    const open = await buy(card.accountId, 25, today);
    const openInvoice = await invoiceIdOf(open.id);
    await expect(transactions.update(userId, open.id, { amount: 26 })).resolves.toBeDefined();
    const payment = await pay(card.id, openInvoice, checking, 5);
    await expect(transactions.update(userId, open.id, { amount: 27 })).rejects.toMatchObject({
      status: 409,
    });

    const leg = await prisma.transaction.findFirstOrThrow({
      where: { cardPaymentId: payment.id, transferDirection: 'out' },
    });
    await expect(transactions.update(userId, leg.id, { amount: 1 })).rejects.toMatchObject({
      status: 409,
    });
    await expect(transactions.remove(userId, leg.id, true)).rejects.toMatchObject({ status: 409 });
  });

  it('cartão não recebe receita; isola pagamentos e estornos por usuário', async () => {
    const checking = await newAccount(1000);
    const card = await newCard();
    await expect(
      transactions.create(userId, {
        accountId: card.accountId,
        type: 'income',
        amount: 10,
        description: 'Devolução',
        transactionDate: today,
      }),
    ).rejects.toMatchObject({ status: 400 });

    const purchase = await buy(card.accountId, 60, today);
    const invoiceId = await invoiceIdOf(purchase.id);
    await expect(
      payments.pay(otherId, card.id, invoiceId, {
        sourceAccountId: checking,
        amount: 10,
        paymentDate: today,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    const payment = await pay(card.id, invoiceId, checking, 10);
    await expect(payments.reverse(otherId, card.id, invoiceId, payment.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      transactions.refund(otherId, purchase.id, { amount: 10, date: today }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
