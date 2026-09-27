import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { dateOnlyString, parseDateOnly, todaySaoPaulo } from '../common/date.util';
import { CreditCardsService } from './credit-cards.service';

const databaseUrl = process.env.SELECTED_FEATURES_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('faturas, ciclos e limite (PostgreSQL)', () => {
  let prisma: PrismaService;
  let transactions: TransactionsService;
  let cards: CreditCardsService;
  let userId: string;
  let otherId: string;
  const today = dateOnlyString(todaySaoPaulo());

  const purchase = (accountId: string, amount: number, date: string, extra = {}) =>
    transactions.create(userId, {
      accountId,
      type: 'expense',
      amount,
      description: `Compra ${date}`,
      transactionDate: date,
      ...extra,
    });

  /** Cartão configurado com controle desde 2026-01-01, para usar datas fixas no passado. */
  async function cardSince(closingDay: number, dueDay: number, creditLimit?: number) {
    const card = await cards.create(userId, {
      name: `Cartão ${randomUUID().slice(0, 6)}`,
      closingDay,
      dueDay,
      creditLimit,
    });
    await prisma.creditCard.update({
      where: { id: card.id },
      data: { invoiceTrackingStart: parseDateOnly('2026-01-01') },
    });
    return card;
  }

  const invoiceOf = async (transactionId: string) => {
    const tx = await prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
      include: { invoice: true },
    });
    return tx.invoice;
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
    transactions = new TransactionsService(prisma, new AccountsService(prisma));
    cards = new CreditCardsService(prisma);
    [userId, otherId] = (
      await Promise.all(
        [0, 1].map(() =>
          prisma.user.create({
            data: {
              name: 'Invoices',
              email: `${randomUUID()}@example.test`,
              passwordHash: 'not-a-login',
              profileType: 'individual',
            },
          }),
        ),
      )
    ).map((u) => u.id);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await prisma.$disconnect();
  });

  it('compra no dia do fechamento vai para a fatura seguinte', async () => {
    const card = await cardSince(10, 17);
    const before = await purchase(card.accountId, 10, '2026-02-09');
    const onClosing = await purchase(card.accountId, 20, '2026-02-10');

    const a = await invoiceOf(before.id);
    const b = await invoiceOf(onClosing.id);
    expect(a?.referenceMonth).toBe('2026-02');
    expect(a?.closingDate.toISOString().slice(0, 10)).toBe('2026-02-10');
    expect(a?.dueDate.toISOString().slice(0, 10)).toBe('2026-02-17');
    expect(b?.referenceMonth).toBe('2026-03');
    expect(b?.periodStart.toISOString().slice(0, 10)).toBe('2026-02-10');

    const list = await cards.invoices(userId, card.id);
    expect(list.map((i) => [i.referenceMonth, i.total, i.state, i.paymentStatus])).toEqual([
      ['2026-03', 20, 'closed', 'unpaid'],
      ['2026-02', 10, 'closed', 'unpaid'],
    ]);
    const detail = await cards.invoice(userId, card.id, a!.id);
    expect(detail.items.map((c) => c.id)).toEqual([before.id]);
  });

  it('parcelado 3x vai para 3 faturas com a soma exata; atual ≠ parcelas futuras; dívida × limite', async () => {
    const card = await cards.create(userId, {
      name: 'Parcelas',
      closingDay: 5,
      dueDay: 12,
      creditLimit: 1000,
    });
    const first = await purchase(card.accountId, 100, today, {
      recurrenceType: 'parcelado',
      installments: 3,
    });
    const series = await prisma.transaction.findMany({
      where: { seriesId: first.seriesId },
      include: { invoice: true },
      orderBy: { installmentNumber: 'asc' },
    });
    expect(series.map((t) => Number(t.amount))).toEqual([33.33, 33.33, 33.34]);
    const refs = series.map((t) => t.invoice?.referenceMonth);
    expect(new Set(refs).size).toBe(3);
    // Faturas consecutivas: cada uma começa no fechamento da anterior.
    expect(series[1].invoice!.periodStart).toEqual(series[0].invoice!.closingDate);
    expect(series[2].invoice!.periodStart).toEqual(series[1].invoice!.closingDate);

    const view = await cards.findOne(userId, card.id);
    expect(view.currentInvoice).toBe(33.33);
    expect(view.futureInstallments).toBe(66.67);
    expect(view.totalDebt).toBe(100);
    expect(view.committed).toBe(100);
    expect(view.available).toBe(900);
    expect(view.percentage).toBe(10);
    expect(view.currentInvoiceId).toBe(series[0].invoiceId);
  });

  it('trocar o fechamento refaz só as faturas futuras', async () => {
    const card = await cardSince(10, 17);
    const past = await purchase(card.accountId, 50, '2026-02-01');
    const pastInvoice = await invoiceOf(past.id);
    const first = await purchase(card.accountId, 90, today, {
      recurrenceType: 'parcelado',
      installments: 3,
    });
    const third = await prisma.transaction.findFirstOrThrow({
      where: { seriesId: first.seriesId, installmentNumber: 3 },
    });
    const currentBefore = await invoiceOf(first.id);

    await cards.update(userId, card.id, { closingDay: 20, dueDay: 27 });

    // Fechada e atual: mesmas datas e mesma fatura.
    expect(await invoiceOf(past.id)).toEqual(pastInvoice);
    expect((await invoiceOf(first.id))?.id).toBe(currentBefore?.id);
    // Futura: refeita com o fechamento novo.
    const future = await invoiceOf(third.id);
    expect(future?.closingDate.getUTCDate()).toBe(20);
    expect(future?.dueDate.getUTCDate()).toBe(27);
    expect((await cards.findOne(userId, card.id)).totalDebt).toBe(140);
  });

  it('editar a data reatribui; cancelar tira da fatura e some com a futura vazia', async () => {
    const card = await cardSince(10, 17);
    // Fatura aberta (futura): edição livre, com reatribuição.
    const tx = await purchase(card.accountId, 30, '2099-02-05');
    expect((await invoiceOf(tx.id))?.referenceMonth).toBe('2099-02');

    await transactions.update(userId, tx.id, { transactionDate: '2099-02-15' });
    expect((await invoiceOf(tx.id))?.referenceMonth).toBe('2099-03');

    const future = await purchase(card.accountId, 40, '2099-01-05');
    const futureInvoice = await invoiceOf(future.id);
    expect(futureInvoice).not.toBeNull();
    await transactions.remove(userId, future.id);
    expect(await invoiceOf(future.id)).toBeNull();
    expect(await prisma.creditCardInvoice.count({ where: { id: futureInvoice!.id } })).toBe(0);
  });

  it('cartão legado: configurar escolhe o início do controle; antes dele fica fora da dívida', async () => {
    const account = await prisma.account.create({
      data: { userId, name: 'Legado', type: 'credit_card' },
    });
    const legacy = await prisma.creditCard.create({ data: { accountId: account.id } });
    const old = await purchase(account.id, 70, '2026-01-15');
    const recent = await purchase(account.id, 80, '2026-03-15');

    const pending = await cards.findOne(userId, legacy.id);
    expect(pending).toMatchObject({ needsSetup: true, totalDebt: null, currentInvoice: null });
    expect(await invoiceOf(recent.id)).toBeNull();
    expect(await cards.invoices(userId, legacy.id)).toEqual([]);

    await expect(
      cards.setup(userId, legacy.id, {
        closingDay: 1,
        dueDay: 8,
        invoiceTrackingStart: '2099-01-01',
      }),
    ).rejects.toMatchObject({ status: 400 });

    const configured = await cards.setup(userId, legacy.id, {
      closingDay: 1,
      dueDay: 8,
      invoiceTrackingStart: '2026-03-01',
    });
    expect(configured).toMatchObject({ needsSetup: false, totalDebt: 80 });
    expect(await invoiceOf(old.id)).toBeNull();
    expect((await invoiceOf(recent.id))?.referenceMonth).toBe('2026-04');
    await expect(
      cards.setup(userId, legacy.id, {
        closingDay: 1,
        dueDay: 8,
        invoiceTrackingStart: '2026-03-01',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('isola as faturas por usuário', async () => {
    const [card] = await cards.findAll(userId);
    await expect(cards.invoices(otherId, card.id)).rejects.toMatchObject({ status: 404 });
    const [first] = await cards.invoices(userId, card.id);
    await expect(cards.invoice(otherId, card.id, first.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});
