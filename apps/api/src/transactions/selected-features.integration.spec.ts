import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { CreditCardsService } from '../credit-cards/credit-cards.service';
import { SpendingGoalsService } from '../spending-goals/spending-goals.service';
import { AgendaEventsService } from '../agenda-events/agenda-events.service';
import { RemindersService } from '../reminders/reminders.service';
import { NotesService } from '../notes/notes.service';
import { TransactionsService } from './transactions.service';
import { todaySaoPaulo } from '../common/date.util';

const databaseUrl = process.env.SELECTED_FEATURES_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('selected features with PostgreSQL', () => {
  let prisma: PrismaService;
  let transactions: TransactionsService;
  let accounts: AccountsService;
  let userId: string;
  let otherId: string;
  let accountId: string;
  let categoryId: string;

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
    const users = await Promise.all(
      [0, 1].map(() =>
        prisma.user.create({
          data: {
            name: 'Integration test',
            email: `${randomUUID()}@example.test`,
            passwordHash: 'not-a-login',
            profileType: 'individual',
          },
        }),
      ),
    );
    [userId, otherId] = users.map((u) => u.id);
    accountId = (
      await accounts.create(userId, { name: 'Checking', type: 'checking', initialBalance: 1000 })
    ).id;
    categoryId = (
      await prisma.category.create({
        data: {
          userId,
          name: 'Test expense',
          type: 'expense',
          profileType: 'individual',
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    if (userId && otherId)
      await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await prisma.$disconnect();
  });

  it('uses the same records for transactions and recurring views; preserves dates and balances', async () => {
    const first = await transactions.create(userId, {
      accountId,
      categoryId,
      description: 'Monthly subscription',
      type: 'expense',
      amount: 100,
      transactionDate: '2028-01-31',
      recurrenceType: 'fixo',
      recurrenceMonths: 3,
    });
    const filters = { periodStart: '2028-01-01', periodEnd: '2028-03-31', order: 'asc' as const };
    const all = await transactions.findAll(userId, filters);
    const recurring = await transactions.findAll(userId, { ...filters, recurrenceType: 'fixo' });
    expect(recurring.data.map((t) => t.id)).toEqual(all.data.map((t) => t.id));
    expect(recurring.data.map((t) => t.transactionDate.toISOString().slice(0, 10))).toEqual([
      '2028-01-31',
      '2028-02-29',
      '2028-03-31',
    ]);
    expect(recurring.data.map((t) => t.status)).toEqual(['confirmed', 'pending', 'pending']);
    expect(new Set(recurring.data.map((t) => t.seriesId)).size).toBe(1);
    expect(Number((await accounts.findOne(userId, accountId)).currentBalance)).toBe(900);
    expect((await transactions.findAll(otherId, { recurrenceType: 'fixo' })).meta.total).toBe(0);
    await expect(transactions.update(otherId, first.id, { amount: 999 })).rejects.toThrow();

    await transactions.update(userId, first.id, {
      description: 'Updated from recurring view',
      amount: 120,
    });
    expect((await transactions.findAll(userId, filters)).data[0].description).toBe(
      'Updated from recurring view',
    );
    expect(Number((await accounts.findOne(userId, accountId)).currentBalance)).toBe(880);
    await transactions.remove(userId, first.id, true);
    expect(
      (await transactions.findAll(userId, { ...filters, recurrenceType: 'fixo' })).meta.total,
    ).toBe(2);
    expect(Number((await accounts.findOne(userId, accountId)).currentBalance)).toBe(1000);
  });

  it('does not classify one-off or installment transactions as fixed; preserves installment cents', async () => {
    await transactions.create(userId, {
      accountId,
      description: 'One-off',
      type: 'expense',
      amount: 10,
      transactionDate: '2028-04-01',
    });
    const first = await transactions.create(userId, {
      accountId,
      description: 'Purchase',
      type: 'expense',
      amount: 100,
      transactionDate: '2028-04-01',
      recurrenceType: 'parcelado',
      installments: 3,
    });
    const installments = await prisma.transaction.findMany({ where: { seriesId: first.seriesId } });
    expect(installments.reduce((sum, t) => sum + Math.round(Number(t.amount) * 100), 0)).toBe(
      10000,
    );
    expect(
      (await transactions.findAll(userId, { recurrenceType: 'fixo', periodStart: '2028-04-01' }))
        .meta.total,
    ).toBe(0);
  });

  it('derives card income from fixed transactions and spending goals from confirmed expenses', async () => {
    const today = todaySaoPaulo();
    const date = `${today.year}-${String(today.monthIndex + 1).padStart(2, '0')}-01`;
    await transactions.create(userId, {
      accountId,
      description: 'Salary',
      type: 'income',
      amount: 5000,
      transactionDate: date,
      recurrenceType: 'fixo',
      recurrenceMonths: 2,
    });
    const cards = new CreditCardsService(prisma, accounts);
    const card = await cards.create(userId, { name: 'Test card', creditLimit: 1000, dueDay: 10 });
    await transactions.create(userId, {
      accountId: card.accountId,
      categoryId,
      description: 'Card expense',
      type: 'expense',
      amount: 100,
      transactionDate: date,
    });
    const summary = await cards.summary(userId);
    expect(summary.monthlyIncome).toBe(5000);
    expect(summary.totalCommitted).toBe(100);
    expect(summary.incomePercentage).toBe(2);
    expect(await cards.findAll(otherId)).toEqual([]);
    const goals = new SpendingGoalsService(prisma);
    await goals.create(userId, { categoryId, amount: 500 });
    expect((await goals.findAll(userId))[0].spent).toBe(100);
    expect(await goals.findAll(otherId)).toEqual([]);
  });

  it('persists appointments, reminders and notes and isolates owners', async () => {
    const agenda = new AgendaEventsService(prisma);
    const reminders = new RemindersService(prisma);
    const notes = new NotesService(prisma);
    const event = await agenda.create(userId, { title: 'Appointment', eventDate: '2028-04-20' });
    const reminder = await reminders.create(userId, {
      title: 'Bill',
      dueDate: '2028-04-20',
      amount: 150,
    });
    expect((await agenda.findAll(userId, '2028-04')).map((e) => e.id)).toContain(event.id);
    expect((await reminders.findAll(userId, '2028-04')).map((r) => r.id)).toContain(reminder.id);
    await reminders.pay(userId, reminder.id);
    expect((await reminders.findAll(userId, '2028-04'))[0].derivedStatus).toBe('paid');
    await reminders.unpay(userId, reminder.id);
    expect((await reminders.findAll(userId, '2028-04'))[0].status).toBe('pending');
    const note = await notes.create(userId, { title: 'Note', content: 'Text' });
    await notes.togglePin(userId, note.id);
    expect((await notes.findAll(userId))[0].isPinned).toBe(true);
    await expect(notes.update(otherId, note.id, { content: 'Intrusion' })).rejects.toThrow();
    expect(await agenda.findAll(otherId, '2028-04')).toEqual([]);
    expect(await reminders.findAll(otherId, '2028-04')).toEqual([]);
    expect(await notes.findAll(otherId)).toEqual([]);
    await agenda.remove(userId, event.id);
    await reminders.remove(userId, reminder.id);
    await notes.remove(userId, note.id);
  });
});
