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

  it('estorno de parcelado em fatura aberta: cancela as parcelas, e o que foi pago antes do fechamento vira crédito', async () => {
    const checking = await newAccount(1000);
    const card = await newCard();
    const first = await buy(card.accountId, 90, today, {
      recurrenceType: 'parcelado',
      installments: 3,
    });
    const currentInvoice = await invoiceIdOf(first.id);
    // Pagamento antes do fechamento não trava a parcela 1: nada foi faturado ainda.
    await pay(card.id, currentInvoice, checking, 10);

    const result = await transactions.refund(userId, first.id, { date: today, scope: 'series' });
    expect(result.refunds).toEqual([]);
    expect(result.cancelled).toHaveLength(3);

    const series = await prisma.transaction.findMany({
      where: { seriesId: first.seriesId },
      orderBy: { installmentNumber: 'asc' },
    });
    expect(series.map((t) => t.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    const view = await cards.findOne(userId, card.id);
    expect(view).toMatchObject({ totalDebt: 0, credit: 10, futureInstallments: 0 });
  });

  it('fatura fechada trava valor e data, não descrição; a aberta não trava nem com pagamento; pernas só via reversão', async () => {
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
    // Pagamento antes do fechamento não congela as compras do mês (docs/adrs/0021).
    const payment = await pay(card.id, openInvoice, checking, 5);
    await expect(transactions.update(userId, open.id, { amount: 27 })).resolves.toMatchObject({
      amount: expect.anything(),
    });
    expect(await invoiceView(card.id, openInvoice)).toMatchObject({ total: 27, remaining: 22 });

    const leg = await prisma.transaction.findFirstOrThrow({
      where: { cardPaymentId: payment.id, transferDirection: 'out' },
    });
    await expect(transactions.update(userId, leg.id, { amount: 1 })).rejects.toMatchObject({
      status: 409,
    });
    await expect(transactions.remove(userId, leg.id, true)).rejects.toMatchObject({ status: 409 });
  });

  // ── Pagamento antes do fechamento (docs/adrs/0021) ─────────────────────────

  it('fatura aberta: paga uma parte, entra compra nova, paga o resto — o limite acompanha', async () => {
    const checking = await newAccount(1000);
    const card = await newCard();
    const first = await buy(card.accountId, 300, today);
    const openInvoice = await invoiceIdOf(first.id);
    expect(await invoiceView(card.id, openInvoice)).toMatchObject({
      state: 'open',
      remaining: 300,
    });
    expect((await cards.findOne(userId, card.id)).available).toBe(4700);

    // Uma parte agora: sai da conta, abate a fatura e libera o limite na hora.
    await pay(card.id, openInvoice, checking, 100);
    expect(await balance(checking)).toBe(900);
    expect(await invoiceView(card.id, openInvoice)).toMatchObject({
      state: 'open',
      total: 300,
      payments: 100,
      remaining: 200,
    });
    expect((await cards.findOne(userId, card.id)).available).toBe(4800);

    // Compra feita depois do pagamento entra na mesma fatura.
    const second = await buy(card.accountId, 50, today);
    expect(await invoiceIdOf(second.id)).toBe(openInvoice);
    expect(await invoiceView(card.id, openInvoice)).toMatchObject({ total: 350, remaining: 250 });

    // O resto: nada a pagar até aqui, e a fatura segue aberta.
    await pay(card.id, openInvoice, checking, 250);
    expect(await balance(checking)).toBe(650);
    expect(await invoiceView(card.id, openInvoice)).toMatchObject({
      state: 'open',
      remaining: 0,
      paymentStatus: 'paid',
    });
    expect(await cards.findOne(userId, card.id)).toMatchObject({ totalDebt: 0, available: 5000 });
  });

  it('fatura aberta já paga: a compra continua editável e excluível, e a sobra vira crédito', async () => {
    const checking = await newAccount(1000);
    const card = await newCard();
    const purchase = await buy(card.accountId, 80, today);
    const openInvoice = await invoiceIdOf(purchase.id);
    await pay(card.id, openInvoice, checking, 80);

    // Corrigir o valor para menos: R$ 20 pagos a mais viram crédito.
    await transactions.update(userId, purchase.id, { amount: 60 });
    expect(await cards.findOne(userId, card.id)).toMatchObject({ totalDebt: 0, credit: 20 });

    // Excluir a compra: tudo o que foi pago vira crédito; o saldo da conta não volta sozinho.
    await transactions.remove(userId, purchase.id);
    expect(await cards.findOne(userId, card.id)).toMatchObject({ totalDebt: 0, credit: 80 });
    expect(await balance(checking)).toBe(920);
  });

  it('pagar a mais na fatura aberta abate a seguinte; desfazer devolve tudo; fatura futura não recebe pagamento', async () => {
    const checking = await newAccount(1000);
    const card = await newCard();
    const first = await buy(card.accountId, 90, today, {
      recurrenceType: 'parcelado',
      installments: 3,
    });
    const [, second, third] = await prisma.transaction.findMany({
      where: { seriesId: first.seriesId },
      orderBy: { installmentNumber: 'asc' },
    });
    const openInvoice = await invoiceIdOf(first.id);

    // A fatura que ainda não começou só tem parcelas futuras: o caminho é adiantar.
    await expect(pay(card.id, third.invoiceId!, checking, 30)).rejects.toMatchObject({
      status: 400,
    });

    // R$ 50 na aberta (R$ 30): os R$ 20 a mais abatem a fatura seguinte.
    const payment = await pay(card.id, openInvoice, checking, 50);
    expect(await invoiceView(card.id, openInvoice)).toMatchObject({ remaining: 0, surplus: 20 });
    expect(await invoiceView(card.id, second.invoiceId!)).toMatchObject({
      total: 30,
      remaining: 10,
    });
    expect((await cards.findOne(userId, card.id)).totalDebt).toBe(40);

    // Desfazer: o dinheiro volta para a conta e a dívida volta inteira.
    await payments.reverse(userId, card.id, openInvoice, payment.id);
    expect(await balance(checking)).toBe(1000);
    expect((await cards.findOne(userId, card.id)).totalDebt).toBe(90);
    expect(await invoiceView(card.id, second.invoiceId!)).toMatchObject({ remaining: 30 });
  });

  it('dashboard: a fatura paga entra em "Saiu da conta" como "Fatura do cartão" e sai de "Foi no cartão"', async () => {
    const checking = await newAccount(1000);
    const card = await newCard();
    await buy(card.accountId, 300, today); // Alimentação
    const uncategorized = await buy(card.accountId, 100, today, { categoryId: undefined });
    const openInvoice = await invoiceIdOf(uncategorized.id);

    const byCategory = (chart: { slices: { categoryName: string; total: number }[] }) =>
      Object.fromEntries(chart.slices.map((s) => [s.categoryName, s.total]));
    const accountsChart = () =>
      dashboard.getAccountsSpending(userId, `${month}-01`, monthEnd, { accountIds: [checking] });
    const cardsChart = () =>
      dashboard.getCardsUnpaid(userId, `${month}-01`, monthEnd, { cardIds: [card.id] });

    // Nada pago: nada saiu da conta; tudo ainda está no cartão.
    expect(await accountsChart()).toMatchObject({ total: 0, slices: [] });
    expect(byCategory(await cardsChart())).toEqual({ Alimentação: 300, 'Sem categoria': 100 });

    // Metade paga: R$ 200 saem da conta; no cartão fica metade de cada categoria.
    const payment = await pay(card.id, openInvoice, checking, 200);
    expect(byCategory(await accountsChart())).toEqual({ 'Fatura do cartão': 200 });
    expect(byCategory(await cardsChart())).toEqual({ Alimentação: 150, 'Sem categoria': 50 });
    // As duas pernas do pagamento levam a categoria.
    const legs = await prisma.transaction.findMany({
      where: { cardPaymentId: payment.id },
      include: { category: true },
    });
    expect(legs.map((leg) => leg.category?.name)).toEqual(['Fatura do cartão', 'Fatura do cartão']);

    // Tudo pago: as compras saem do gráfico do cartão.
    await pay(card.id, openInvoice, checking, 200);
    expect(await accountsChart()).toMatchObject({ total: 400 });
    expect(await cardsChart()).toMatchObject({ total: 0, slices: [] });
    // "Para onde foi seu dinheiro" continua por categoria da compra, sem a fatura.
    const summary = await dashboard.getSummary(userId, `${month}-01`, monthEnd, {
      cardIds: [card.id],
      accountIds: [checking],
    });
    expect(byCategory({ slices: summary.expensesByCategory })).toEqual({
      Alimentação: 300,
      'Sem categoria': 100,
    });
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
