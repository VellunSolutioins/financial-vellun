import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CreditCardsService } from '../credit-cards/credit-cards.service';
import { CardPaymentsService } from '../credit-cards/card-payments.service';
import { addDaysSaoPaulo, dateOnlyString, parseDateOnly, todaySaoPaulo } from '../common/date.util';
import { DashboardService } from './dashboard.service';

const databaseUrl = process.env.SELECTED_FEATURES_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('próximas contas a pagar (PostgreSQL)', () => {
  let prisma: PrismaService;
  let dashboard: DashboardService;
  let userId: string;
  const today = todaySaoPaulo();
  const inDays = (n: number) => dateOnlyString(addDaysSaoPaulo(today, n));

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
    dashboard = new DashboardService(prisma);
    userId = (
      await prisma.user.create({
        data: {
          name: 'Upcoming',
          email: `${randomUUID()}@example.test`,
          passwordHash: 'not-a-login',
          profileType: 'individual',
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('uma ocorrência por série e faturas no lugar das compras do cartão', async () => {
    const accounts = new AccountsService(prisma);
    const transactions = new TransactionsService(prisma, accounts);
    const cards = new CreditCardsService(prisma);
    const checking = (await accounts.create(userId, { name: 'Conta', type: 'checking' })).id;
    const card = await cards.create(userId, { name: 'Nubank', closingDay: 10, dueDay: 17 });
    await prisma.creditCard.update({
      where: { id: card.id },
      data: { invoiceTrackingStart: parseDateOnly('2026-01-01') },
    });
    const expense = (accountId: string, amount: number, date: string, extra = {}) =>
      transactions.create(userId, {
        accountId,
        type: 'expense',
        amount,
        description: `Despesa ${amount}`,
        transactionDate: date,
        ...extra,
      });

    // Recorrência mensal: só a próxima ocorrência entra.
    const rent = await expense(checking, 1800, inDays(3), {
      recurrenceType: 'fixo',
      recurrenceMonths: 3,
    });
    const single = await expense(checking, 35, inDays(1));
    // Cartão: fatura fechada (vencida, sem pagamento) e compras da fatura aberta.
    const oldPurchase = await expense(card.accountId, 50, '2026-02-05');
    await expense(card.accountId, 120, dateOnlyString(today));
    await expense(card.accountId, 90, dateOnlyString(today), {
      recurrenceType: 'parcelado',
      installments: 3,
    });

    const bills = (await dashboard.getSummary(userId)).upcomingBills;
    const byKind = (kind: string) => bills.filter((b) => b.kind === kind);

    expect(byKind('transaction').map((b) => b.id)).toEqual([single.id, rent.id]);
    // Nenhuma compra de cartão aparece individualmente.
    expect(bills.some((b) => b.kind === 'transaction' && b.accountId === card.accountId)).toBe(
      false,
    );

    const invoices = byKind('invoice');
    const current = await cards.findOne(userId, card.id);
    const closedInvoiceId = (
      await prisma.transaction.findUniqueOrThrow({ where: { id: oldPurchase.id } })
    ).invoiceId;
    expect(invoices).toEqual([
      expect.objectContaining({
        id: closedInvoiceId,
        description: 'Fatura Nubank',
        amount: 50,
        invoiceState: 'closed',
      }),
      // Atual: compra de 120 + 1ª parcela de 30. As parcelas seguintes ficam fora.
      expect.objectContaining({ id: current.currentInvoiceId, amount: 150, invoiceState: 'open' }),
    ]);
    // Ordem por vencimento: a fatura vencida vem primeiro.
    expect(bills[0].id).toBe(closedInvoiceId);

    // Fatura quitada sai da lista.
    const checkingForPayment = await accounts.create(userId, {
      name: 'Pagadora',
      type: 'checking',
      initialBalance: 100,
    });
    await new CardPaymentsService(prisma, accounts).pay(userId, card.id, closedInvoiceId!, {
      sourceAccountId: checkingForPayment.id,
      amount: 50,
      paymentDate: dateOnlyString(today),
      idempotencyKey: randomUUID(),
    });
    const after = (await dashboard.getSummary(userId)).upcomingBills;
    expect(after.some((b) => b.id === closedInvoiceId)).toBe(false);
  });
});
