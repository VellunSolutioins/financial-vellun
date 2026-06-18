import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getSummary(userId: string, periodStart?: string, periodEnd?: string) {
    const now = new Date();
    const start = periodStart ? new Date(periodStart) : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = periodEnd ? new Date(periodEnd) : new Date(now.getFullYear(), now.getMonth() + 1, 0);

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

    // Monthly comparison (last 3 months)
    const monthlyComparison = await this.getMonthlyComparison(userId, 3);

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
    const start = periodStart ? new Date(periodStart) : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = periodEnd ? new Date(periodEnd) : new Date(now.getFullYear(), now.getMonth() + 1, 0);

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

  private async getMonthlyComparison(userId: string, months: number) {
    const result = [];
    const now = new Date();

    for (let i = months - 1; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const start = new Date(date.getFullYear(), date.getMonth(), 1);
      const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);

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
        month: date.toISOString().slice(0, 7),
        income: Number(inc._sum.amount ?? 0),
        expense: Number(exp._sum.amount ?? 0),
      });
    }
    return result;
  }
}
