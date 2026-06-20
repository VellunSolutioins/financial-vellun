import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  startOfDayUtc,
  endOfDayUtc,
  startOfMonthUtc,
  endOfMonthUtc,
} from '../common/date.util';

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

    const [accounts, incomeAgg, expenseAgg, expensesByCategory, recentTransactions] =
      await Promise.all([
        this.prisma.account.findMany({ where: { userId, isActive: true }, select: { currentBalance: true } }),
        this.prisma.transaction.aggregate({
          where: { userId, type: 'income', status: 'confirmed', transactionDate: { gte: start, lte: end } },
          _sum: { amount: true },
        }),
        this.prisma.transaction.aggregate({
          where: { userId, type: 'expense', status: 'confirmed', transactionDate: { gte: start, lte: end } },
          _sum: { amount: true },
        }),
        this.prisma.transaction.groupBy({
          by: ['categoryId'],
          where: { userId, type: 'expense', status: 'confirmed', transactionDate: { gte: start, lte: end } },
          _sum: { amount: true },
          orderBy: { _sum: { amount: 'desc' } },
        }),
        this.prisma.transaction.findMany({
          where: { userId },
          include: { category: true, account: true },
          orderBy: { createdAt: 'desc' },
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

    const [accounts, confirmedInPeriod, expensesByCategory, accountsReceivable, accountsPayable] =
      await Promise.all([
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
          where: { userId, type: 'expense', status: 'confirmed', transactionDate: { gte: start, lte: end } },
          _sum: { amount: true },
          orderBy: { _sum: { amount: 'desc' } },
          take: 5,
        }),
        this.prisma.transaction.findMany({
          where: { userId, type: 'income', status: 'pending' },
          include: { category: true, account: true },
          orderBy: { transactionDate: 'asc' },
        }),
        this.prisma.transaction.findMany({
          where: { userId, type: 'expense', status: 'pending' },
          include: { category: true, account: true },
          orderBy: { transactionDate: 'asc' },
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

    const totalReceivable = accountsReceivable.reduce((sum, t) => sum + Number(t.amount), 0);
    const totalPayable = accountsPayable.reduce((sum, t) => sum + Number(t.amount), 0);

    return {
      totalBalance,
      totalIncome,
      totalExpense,
      netResult: totalIncome - totalExpense,
      cashFlow,
      topExpenseCategories,
      accountsReceivable: { total: totalReceivable, items: accountsReceivable },
      accountsPayable: { total: totalPayable, items: accountsPayable },
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

  private async getMonthlyComparison(userId: string, months: number) {
    const result = [];
    const now = new Date();

    for (let i = months - 1; i >= 0; i--) {
      const ref = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = ref.getFullYear();
      const monthIndex = ref.getMonth();
      const start = startOfMonthUtc(year, monthIndex);
      const end = endOfMonthUtc(year, monthIndex);

      const [inc, exp] = await Promise.all([
        this.prisma.transaction.aggregate({
          where: { userId, type: 'income', status: 'confirmed', transactionDate: { gte: start, lte: end } },
          _sum: { amount: true },
        }),
        this.prisma.transaction.aggregate({
          where: { userId, type: 'expense', status: 'confirmed', transactionDate: { gte: start, lte: end } },
          _sum: { amount: true },
        }),
      ]);

      result.push({
        month: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
        income: Number(inc._sum.amount ?? 0),
        expense: Number(exp._sum.amount ?? 0),
      });
    }
    return result;
  }
}
