import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  startOfDayUtc,
  endOfDayUtc,
  startOfMonthUtc,
  endOfMonthUtc,
  todaySaoPaulo,
  dateOnlyString,
} from '../common/date.util';

/**
 * Itens de conta a pagar/receber trazidos junto do dashboard empresarial.
 *
 * O widget mostra uma prévia e leva para a tela completa; trazer a lista
 * inteira era carregar tudo para exibir cinco. Os totais não dependem deste
 * corte — vêm de uma agregação à parte.
 */
const PENDING_PREVIEW_LIMIT = 5;

/** Linha do comparativo mensal, como o Postgres devolve. */
export type MonthlyTotalRow = {
  month: string;
  type: 'income' | 'expense';
  /** `numeric` vem como texto para não passar por float no caminho. */
  total: string | null;
};

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getSummary(userId: string, periodStart?: string, periodEnd?: string) {
    const now = new Date();
    const start = periodStart
      ? startOfDayUtc(periodStart)
      : startOfMonthUtc(now.getFullYear(), now.getMonth());
    const end = periodEnd
      ? endOfDayUtc(periodEnd)
      : endOfMonthUtc(now.getFullYear(), now.getMonth());

    const [accounts, incomeAgg, expenseAgg, expensesByCategory, recentTransactions, upcomingBills] =
      await Promise.all([
        this.prisma.account.findMany({
          where: { userId, isActive: true, type: { not: 'credit_card' } },
          select: { currentBalance: true },
        }),
        this.prisma.transaction.aggregate({
          where: {
            userId,
            type: 'income',
            status: 'confirmed',
            transactionDate: { gte: start, lte: end },
          },
          _sum: { amount: true },
        }),
        this.prisma.transaction.aggregate({
          where: {
            userId,
            type: 'expense',
            status: 'confirmed',
            transactionDate: { gte: start, lte: end },
          },
          _sum: { amount: true },
        }),
        this.prisma.transaction.groupBy({
          by: ['categoryId'],
          where: {
            userId,
            type: 'expense',
            status: 'confirmed',
            transactionDate: { gte: start, lte: end },
          },
          _sum: { amount: true },
          orderBy: { _sum: { amount: 'desc' } },
        }),
        this.prisma.transaction.findMany({
          where: { userId },
          include: { category: true, account: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
        this.prisma.transaction.findMany({
          where: {
            userId,
            type: 'expense',
            status: 'confirmed',
            transactionDate: { gte: startOfDayUtc(dateOnlyString(todaySaoPaulo())) },
          },
          include: { category: true, account: true },
          orderBy: { transactionDate: 'asc' },
          take: 5,
        }),
      ]);

    const totalBalance = accounts.reduce((sum, a) => sum + Number(a.currentBalance), 0);
    const totalIncome = Number(incomeAgg._sum.amount ?? 0);
    const totalExpense = Number(expenseAgg._sum.amount ?? 0);

    // Resolve category names
    const categoryIds = expensesByCategory.map((e) => e.categoryId).filter(Boolean) as string[];
    const categories = await this.prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true },
    });
    const categoryMap = Object.fromEntries(categories.map((c) => [c.id, c.name]));

    const expensesByCategoryResult = expensesByCategory.map((e) => ({
      categoryId: e.categoryId,
      categoryName: e.categoryId ? (categoryMap[e.categoryId] ?? 'Sem categoria') : 'Sem categoria',
      total: Number(e._sum.amount ?? 0),
      percentage: totalExpense > 0 ? (Number(e._sum.amount ?? 0) / totalExpense) * 100 : 0,
    }));

    // Monthly comparison (last 12 months) — usado no gráfico de evolução mensal
    const monthlyComparison = await this.getMonthlyComparison(userId, 12);

    return {
      totalBalance,
      totalIncome,
      totalExpense,
      netResult: totalIncome - totalExpense,
      expensesByCategory: expensesByCategoryResult,
      recentTransactions,
      upcomingBills,
      monthlyComparison,
    };
  }

  async getBusinessSummary(userId: string, periodStart?: string, periodEnd?: string) {
    const now = new Date();
    const start = periodStart
      ? startOfDayUtc(periodStart)
      : startOfMonthUtc(now.getFullYear(), now.getMonth());
    const end = periodEnd
      ? endOfDayUtc(periodEnd)
      : endOfMonthUtc(now.getFullYear(), now.getMonth());
    // A pagar/receber = o que ainda vai acontecer: confirmado com data de hoje
    // em diante. Não existe status pendente.
    const upcoming = {
      status: 'confirmed' as const,
      transactionDate: { gte: startOfDayUtc(dateOnlyString(todaySaoPaulo())) },
    };

    const [
      accounts,
      confirmedInPeriod,
      expensesByCategory,
      accountsReceivable,
      accountsPayable,
      pendingTotals,
    ] = await Promise.all([
      this.prisma.account.findMany({
        where: { userId, isActive: true },
        select: { currentBalance: true },
      }),
      this.prisma.transaction.findMany({
        where: {
          userId,
          status: 'confirmed',
          type: { in: ['income', 'expense'] },
          transactionDate: { gte: start, lte: end },
        },
        select: { type: true, amount: true, transactionDate: true },
        orderBy: { transactionDate: 'asc' },
      }),
      this.prisma.transaction.groupBy({
        by: ['categoryId'],
        where: {
          userId,
          type: 'expense',
          status: 'confirmed',
          transactionDate: { gte: start, lte: end },
        },
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 5,
      }),
      this.prisma.transaction.findMany({
        where: { userId, type: 'income', ...upcoming },
        include: { category: true, account: true },
        orderBy: { transactionDate: 'asc' },
        take: PENDING_PREVIEW_LIMIT,
      }),
      this.prisma.transaction.findMany({
        where: { userId, type: 'expense', ...upcoming },
        include: { category: true, account: true },
        orderBy: { transactionDate: 'asc' },
        take: PENDING_PREVIEW_LIMIT,
      }),
      // Os totais não podem sair da prévia acima: uma soma de cinco itens
      // mostraria "R$ 1.200 a receber" com R$ 80 mil em aberto. Uma agregação
      // só cobre receber e pagar, e é ela que conta quantos existem.
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: { userId, ...upcoming, type: { in: ['income', 'expense'] } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    const totalBalance = accounts.reduce((sum, a) => sum + Number(a.currentBalance), 0);

    let totalIncome = 0;
    let totalExpense = 0;
    const dailyMap = new Map<string, { income: number; expense: number }>();
    for (const t of confirmedInPeriod) {
      const amount = Number(t.amount);
      const day = t.transactionDate.toISOString().slice(0, 10);
      const entry = dailyMap.get(day) ?? { income: 0, expense: 0 };
      if (t.type === 'income') {
        totalIncome += amount;
        entry.income += amount;
      } else {
        totalExpense += amount;
        entry.expense += amount;
      }
      dailyMap.set(day, entry);
    }

    // Daily cash flow with running balance over the period
    let runningBalance = 0;
    const cashFlow = [...dailyMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, { income, expense }]) => {
        runningBalance += income - expense;
        return { date, income, expense, balance: runningBalance };
      });

    const categoryIds = expensesByCategory.map((e) => e.categoryId).filter(Boolean) as string[];
    const categories = await this.prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true },
    });
    const categoryMap = Object.fromEntries(categories.map((c) => [c.id, c.name]));

    const topExpenseCategories = expensesByCategory.map((e) => ({
      categoryId: e.categoryId,
      categoryName: e.categoryId ? (categoryMap[e.categoryId] ?? 'Sem categoria') : 'Sem categoria',
      total: Number(e._sum.amount ?? 0),
      percentage: totalExpense > 0 ? (Number(e._sum.amount ?? 0) / totalExpense) * 100 : 0,
    }));

    const receivableAgg = pendingTotals.find((p) => p.type === 'income');
    const payableAgg = pendingTotals.find((p) => p.type === 'expense');

    return {
      totalBalance,
      totalIncome,
      totalExpense,
      netResult: totalIncome - totalExpense,
      cashFlow,
      topExpenseCategories,
      accountsReceivable: {
        total: Number(receivableAgg?._sum.amount ?? 0),
        // `count` é o total em aberto; `items` é só a prévia. O widget precisa
        // dos dois para não dar a entender que há apenas cinco.
        count: receivableAgg?._count._all ?? 0,
        items: accountsReceivable,
      },
      accountsPayable: {
        total: Number(payableAgg?._sum.amount ?? 0),
        count: payableAgg?._count._all ?? 0,
        items: accountsPayable,
      },
    };
  }

  /**
   * Lançamentos diários (confirmados) de um mês. Retorna um ponto por dia do
   * mês (income/expense, zero quando não há). ``month`` no formato ``YYYY-MM``;
   * sem ele, usa o mês atual. Cálculo em UTC para casar com a data armazenada.
   */
  async getDailyBreakdown(userId: string, month?: string) {
    const now = new Date();
    let year: number;
    let monthIndex: number;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      year = y;
      monthIndex = m - 1;
    } else {
      year = now.getUTCFullYear();
      monthIndex = now.getUTCMonth();
    }

    const start = new Date(Date.UTC(year, monthIndex, 1));
    const end = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
    const daysInMonth = end.getUTCDate();

    const transactions = await this.prisma.transaction.findMany({
      where: {
        userId,
        status: 'confirmed',
        type: { in: ['income', 'expense'] },
        transactionDate: { gte: start, lte: end },
      },
      select: { type: true, amount: true, transactionDate: true },
    });

    const byDay = new Map<number, { income: number; expense: number }>();
    for (let d = 1; d <= daysInMonth; d++) byDay.set(d, { income: 0, expense: 0 });

    for (const t of transactions) {
      const day = Number(t.transactionDate.toISOString().slice(8, 10));
      const entry = byDay.get(day);
      if (!entry) continue;
      if (t.type === 'income') entry.income += Number(t.amount);
      else entry.expense += Number(t.amount);
    }

    return {
      month: start.toISOString().slice(0, 7),
      days: [...byDay.entries()].map(([day, v]) => ({
        day,
        income: v.income,
        expense: v.expense,
      })),
    };
  }

  /**
   * Receita e despesa confirmadas por mês, nos últimos `months` meses.
   *
   * Uma query. Antes eram duas agregações por mês, em série — 24 idas ao banco
   * para montar um gráfico, cada uma com o custo fixo de round-trip. O ganho
   * não está no trabalho do Postgres (que era pequeno em cada uma), e sim em
   * parar de pagar 24 vezes por ele; sob pool compartilhado, era também o
   * caminho mais fácil de esgotar conexão.
   *
   * `$queryRaw` porque o `groupBy` do Prisma não expressa `date_trunc`. O
   * `userId` vai como parâmetro; os enums entram como literal, que o Postgres
   * coage para o tipo da coluna — passá-los como parâmetro exigiria cast
   * explícito para o nome do enum gerado.
   *
   * Meses sem lançamento **não** voltam do banco, e o gráfico precisa deles
   * como zero: a grade dos meses é montada aqui, e o resultado do banco só a
   * preenche.
   */
  private async getMonthlyComparison(userId: string, months: number) {
    const now = new Date();
    // Mesma janela do laço anterior: os `months` meses terminando no corrente.
    const first = startOfMonthUtc(now.getFullYear(), now.getMonth() - (months - 1));
    const last = endOfMonthUtc(now.getFullYear(), now.getMonth());

    const rows = await this.prisma.$queryRaw<MonthlyTotalRow[]>`
      SELECT to_char(date_trunc('month', "transaction_date"), 'YYYY-MM') AS month,
             "type"::text AS type,
             sum("amount")::text AS total
        FROM "transactions"
       WHERE "user_id" = ${userId}
         AND "status" = 'confirmed'
         AND "type" IN ('income', 'expense')
         AND "transaction_date" >= ${first.toISOString().slice(0, 10)}::date
         AND "transaction_date" <= ${last.toISOString().slice(0, 10)}::date
       GROUP BY 1, 2
    `;

    return buildMonthlySeries(rows, now, months);
  }
}

/**
 * Monta a série de `months` meses terminando no mês de `now`, preenchendo com
 * as linhas agregadas do banco e com zero onde não houve lançamento.
 *
 * Fora da classe para que o teste possa comparar esta montagem, linha a linha,
 * com a versão que fazia uma agregação por mês.
 */
export function buildMonthlySeries(
  rows: MonthlyTotalRow[],
  now: Date,
  months: number,
): { month: string; income: number; expense: number }[] {
  const series: { month: string; income: number; expense: number }[] = [];
  const indexOfMonth = new Map<string, number>();

  for (let i = months - 1; i >= 0; i--) {
    const ref = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}`;
    indexOfMonth.set(key, series.length);
    series.push({ month: key, income: 0, expense: 0 });
  }

  for (const row of rows) {
    const index = indexOfMonth.get(row.month);
    // Linha fora da janela (dado de borda) é ignorada, em vez de virar um mês
    // extra no meio do gráfico.
    if (index === undefined) continue;
    series[index][row.type] = Number(row.total ?? 0);
  }

  return series;
}
