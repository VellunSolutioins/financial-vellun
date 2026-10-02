import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { CreditCardsService } from '../credit-cards/credit-cards.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { TransactionsService } from './transactions.service';
import { competenceString, todaySaoPaulo } from '../common/date.util';

const databaseUrl = process.env.SELECTED_FEATURES_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('visões por conta, cartão, conjunto e consolidado (PostgreSQL)', () => {
  let prisma: PrismaService;
  let transactions: TransactionsService;
  let dashboard: DashboardService;
  let userId: string;
  let otherId: string;
  let accountId: string;
  let cardId: string;
  let foodId: string;

  // Mês corrente: o comparativo mensal do dashboard cobre só os últimos 12.
  // Mês anterior: as datas 10 e 12 já passaram em qualquer dia do mês atual,
  // então as compras são gastos realizados (não previsões) — docs/adrs/0018.
  const today = todaySaoPaulo();
  const month = competenceString({ ...today, monthIndex: today.monthIndex - 1, day: 1 });
  const lastDay = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  const period = { periodStart: `${month}-01`, periodEnd: `${month}-${lastDay}` };

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
    const accounts = new AccountsService(prisma);
    transactions = new TransactionsService(prisma, accounts);
    dashboard = new DashboardService(prisma);

    [userId, otherId] = (
      await Promise.all(
        [0, 1].map(() =>
          prisma.user.create({
            data: {
              name: 'Resource views',
              email: `${randomUUID()}@example.test`,
              passwordHash: 'not-a-login',
              profileType: 'individual',
            },
          }),
        ),
      )
    ).map((u) => u.id);

    accountId = (await accounts.create(userId, { name: 'Conta', type: 'checking' })).id;
    const card = await new CreditCardsService(prisma).create(userId, {
      name: 'Cartão',
      closingDay: 5,
      dueDay: 12,
    });
    cardId = card.id;
    foodId = (
      await prisma.category.create({
        data: { userId, name: 'Alimentação', type: 'expense', profileType: 'individual' },
      })
    ).id;

    await transactions.create(userId, {
      accountId,
      categoryId: foodId,
      type: 'expense',
      amount: 200,
      description: 'Mercado',
      transactionDate: `${month}-10`,
    });
    await transactions.create(userId, {
      accountId: card.accountId,
      categoryId: foodId,
      type: 'expense',
      amount: 350,
      description: 'Restaurante',
      transactionDate: `${month}-12`,
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await prisma.$disconnect();
  });

  const foodTotal = (summary: { byCategory: { categoryId: string | null; total: number }[] }) =>
    summary.byCategory.find((c) => c.categoryId === foodId)?.total ?? 0;

  it('Alimentação: 550 consolidado, 200 na conta, 350 no cartão', async () => {
    const all = await transactions.summary(userId, period);
    const onAccount = await transactions.summary(userId, { ...period, accountIds: [accountId] });
    const onCard = await transactions.summary(userId, { ...period, cardIds: [cardId] });
    const both = await transactions.summary(userId, {
      ...period,
      accountIds: [accountId],
      cardIds: [cardId],
    });

    expect([foodTotal(all), foodTotal(onAccount), foodTotal(onCard), foodTotal(both)]).toEqual([
      550, 200, 350, 550,
    ]);
    expect(all.expense).toBe(550);
    expect(onCard.expense).toBe(350);

    const dash = (filter = {}) =>
      dashboard.getSummary(userId, period.periodStart, period.periodEnd, filter);
    expect((await dash()).spending.realized).toBe(550);
    expect((await dash()).lastEntryMonth).toBe(month);
    expect((await dash({ accountIds: [accountId] })).spending.realized).toBe(200);
    expect((await dash({ cardIds: [cardId] })).spending.realized).toBe(350);
    const onlyCard = await dash({ cardIds: [cardId] });
    expect(onlyCard.expensesByCategory).toEqual([
      expect.objectContaining({ categoryId: foodId, total: 350 }),
    ]);
    // Cartão não tem saldo: no recorte só de cartão, o saldo em contas não
    // existe (nulo) — zero não seria uma medida útil daquele recurso.
    expect(onlyCard.cashBalance).toBeNull();
    expect(onlyCard.cards).toMatchObject({ cardCount: 1 });
    // O comparativo mensal (SQL cru) respeita o mesmo recorte.
    const ofMonth = (s: typeof onlyCard) => s.monthlyComparison.find((m) => m.month === month);
    expect(ofMonth(onlyCard)?.expense).toBe(350);
    expect(ofMonth(await dash())?.expense).toBe(550);

    const daily = await dashboard.getDailyBreakdown(userId, month, { cardIds: [cardId] });
    expect(daily.days.find((d) => d.day === 12)?.expense).toBe(350);
    expect(daily.days.find((d) => d.day === 10)?.expense).toBe(0);
  });

  it('os totais não dependem da paginação', async () => {
    const page = await transactions.findAll(userId, { ...period, page: 2, limit: 1 });
    expect(page.data).toHaveLength(1);
    expect(page.meta.total).toBe(2);
    expect((await transactions.summary(userId, period)).expense).toBe(550);

    const cardOnly = await transactions.findAll(userId, { ...period, cardIds: [cardId] });
    expect(cardOnly.data.map((t) => t.description)).toEqual(['Restaurante']);
  });

  it('recusa conta ou cartão de outro usuário, e cartão passado como conta', async () => {
    await expect(
      transactions.findAll(otherId, { ...period, accountIds: [accountId] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      transactions.summary(otherId, { ...period, cardIds: [cardId] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      dashboard.getSummary(otherId, period.periodStart, period.periodEnd, { cardIds: [cardId] }),
    ).rejects.toMatchObject({ status: 400 });
    const card = await prisma.creditCard.findUniqueOrThrow({ where: { id: cardId } });
    await expect(
      transactions.summary(userId, { ...period, accountIds: [card.accountId] }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
