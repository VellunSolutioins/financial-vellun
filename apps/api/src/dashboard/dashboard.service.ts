import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REGULAR_ACCOUNT_WHERE } from '../accounts/account-types';
import {
  NET_EXPENSE_TYPES,
  netExpenseByCategory,
  netExpenseOf,
  roundCents,
} from '../transactions/net-expense';
import {
  ResourceFilterDto,
  ResourceScope,
  ScopedAccountIds,
  scopeWhere,
} from '../common/resource-scope';
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
  /** `refund` é subtraído da despesa do mês. */
  type: 'income' | 'expense' | 'refund';
  /** `numeric` vem como texto para não passar por float no caminho. */
  total: string | null;
};

/**
 * Período pedido ou, sem ele, o mês corrente **em America/Sao_Paulo** — o
 * relógio do servidor (UTC) já virou o mês às 21h do último dia.
 */
function periodBounds(periodStart?: string, periodEnd?: string) {
  const today = todaySaoPaulo();
  return {
    start: periodStart ? startOfDayUtc(periodStart) : startOfMonthUtc(today.year, today.monthIndex),
    end: periodEnd ? endOfDayUtc(periodEnd) : endOfMonthUtc(today.year, today.monthIndex),
  };
}

/** Contas comuns ativas dentro do recorte: é delas o "saldo total". */
function balanceAccountsWhere(userId: string, scoped: ScopedAccountIds) {
  return {
    userId,
    isActive: true,
    ...REGULAR_ACCOUNT_WHERE,
    ...(scoped ? { id: { in: scoped } } : {}),
  };
}

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private resourceScope: ResourceScope = new ResourceScope(prisma),
  ) {}

  /**
   * Visão pessoal. Receitas, despesas e categorias são por competência (data do
   * lançamento ou da parcela), inclusive as de cartão; o saldo é só das contas
   * comuns, porque cartão não tem saldo.
   */
  async getSummary(
    userId: string,
    periodStart?: string,
    periodEnd?: string,
    filter: ResourceFilterDto = {},
  ) {
    const { start, end } = periodBounds(periodStart, periodEnd);
    const scoped = await this.resourceScope.resolve(userId, filter);
    const inScope = scopeWhere(scoped);

    const [accounts, incomeAgg, expenseAgg, expensesByCategory, recentTransactions, upcomingBills] =
      await Promise.all([
        this.prisma.account.findMany({
          where: balanceAccountsWhere(userId, scoped),
          select: { currentBalance: true },
        }),
        this.prisma.transaction.aggregate({
          where: {
            userId,
            ...inScope,
            type: 'income',
            status: 'confirmed',
            transactionDate: { gte: start, lte: end },
          },
          _sum: { amount: true },
        }),
        this.prisma.transaction.groupBy({
          by: ['type'],
          where: {
            userId,
            ...inScope,
            type: { in: [...NET_EXPENSE_TYPES] },
            status: 'confirmed',
            transactionDate: { gte: start, lte: end },
          },
          _sum: { amount: true },
        }),
        this.prisma.transaction.groupBy({
          by: ['categoryId', 'type'],
          where: {
            userId,
            ...inScope,
            type: { in: [...NET_EXPENSE_TYPES] },
            status: 'confirmed',
            transactionDate: { gte: start, lte: end },
          },
          _sum: { amount: true },
        }),
        this.prisma.transaction.findMany({
          where: { userId, ...inScope },
          include: { category: true, account: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
        this.prisma.transaction.findMany({
          where: {
            userId,
            ...inScope,
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
    // Despesa líquida de estornos (competência).
    const totalExpense = roundCents(netExpenseOf(expenseAgg));
    const expensesByCategoryResult = await this.categoryTotals(
      netExpenseByCategory(expensesByCategory),
      totalExpense,
    );

    // Monthly comparison (last 12 months) — usado no gráfico de evolução mensal
    const [monthlyComparison, lastEntry] = await Promise.all([
      this.getMonthlyComparison(userId, 12, scoped),
      // Até onde vão os lançamentos agendados (recorrências e parcelas): a tela
      // oferece os meses futuros até aqui no seletor de mês.
      this.prisma.transaction.aggregate({
        where: {
          userId,
          ...inScope,
          status: 'confirmed',
          type: { in: ['income', ...NET_EXPENSE_TYPES] },
        },
        _max: { transactionDate: true },
      }),
    ]);
    const lastDate = lastEntry._max.transactionDate;

    return {
      totalBalance,
      totalIncome,
      totalExpense,
      netResult: totalIncome - totalExpense,
      expensesByCategory: expensesByCategoryResult,
      recentTransactions,
      upcomingBills,
      monthlyComparison,
      /** `YYYY-MM` do último lançamento confirmado (pode ser futuro); nulo se não há nenhum. */
      lastEntryMonth: lastDate ? lastDate.toISOString().slice(0, 7) : null,
    };
  }

  /**
   * Visão empresarial. Receita, despesa e categorias por competência; o fluxo de
   * caixa só considera contas comuns — compra no cartão não é saída de caixa.
   */
  async getBusinessSummary(
    userId: string,
    periodStart?: string,
    periodEnd?: string,
    filter: ResourceFilterDto = {},
  ) {
    const { start, end } = periodBounds(periodStart, periodEnd);
    const scoped = await this.resourceScope.resolve(userId, filter);
    const inScope = scopeWhere(scoped);
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
        where: balanceAccountsWhere(userId, scoped),
        select: { currentBalance: true },
      }),
      this.prisma.transaction.findMany({
        where: {
          userId,
          ...inScope,
          status: 'confirmed',
          type: { in: ['income', 'expense', 'refund', 'transfer'] },
          transactionDate: { gte: start, lte: end },
        },
        select: {
          type: true,
          amount: true,
          transactionDate: true,
          transferDirection: true,
          account: { select: { type: true } },
        },
        orderBy: { transactionDate: 'asc' },
      }),
      this.prisma.transaction.groupBy({
        by: ['categoryId', 'type'],
        where: {
          userId,
          ...inScope,
          type: { in: [...NET_EXPENSE_TYPES] },
          status: 'confirmed',
          transactionDate: { gte: start, lte: end },
        },
        _sum: { amount: true },
      }),
      this.prisma.transaction.findMany({
        where: { userId, ...inScope, type: 'income', ...upcoming },
        include: { category: true, account: true },
        orderBy: { transactionDate: 'asc' },
        take: PENDING_PREVIEW_LIMIT,
      }),
      this.prisma.transaction.findMany({
        where: { userId, ...inScope, type: 'expense', ...upcoming },
        include: { category: true, account: true },
        orderBy: { transactionDate: 'asc' },
        take: PENDING_PREVIEW_LIMIT,
      }),
      // Os totais não podem sair da prévia acima: uma soma de cinco itens
      // mostraria "R$ 1.200 a receber" com R$ 80 mil em aberto. Uma agregação
      // só cobre receber e pagar, e é ela que conta quantos existem.
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: { userId, ...inScope, ...upcoming, type: { in: ['income', 'expense'] } },
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
      // Competência: receita e despesa líquida de estornos.
      if (t.type === 'income') totalIncome += amount;
      else if (t.type === 'expense') totalExpense += amount;
      else if (t.type === 'refund') totalExpense -= amount;

      // Caixa: só o que passou por conta comum. Estorno é entrada; pagamento de
      // fatura (perna que sai da conta) é saída; transferência sem direção
      // (legado) não conta.
      if (t.account.type === 'credit_card') continue;
      const cashIn = t.type === 'income' || t.type === 'refund';
      const cashOut =
        t.type === 'expense' || (t.type === 'transfer' && t.transferDirection === 'out');
      if (!cashIn && !cashOut) continue;
      const day = t.transactionDate.toISOString().slice(0, 10);
      const entry = dailyMap.get(day) ?? { income: 0, expense: 0 };
      if (cashIn) entry.income += amount;
      else entry.expense += amount;
      dailyMap.set(day, entry);
    }
    totalExpense = roundCents(totalExpense);

    // Fluxo de caixa diário com saldo acumulado no período
    let runningBalance = 0;
    const cashFlow = [...dailyMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, { income, expense }]) => {
        runningBalance += income - expense;
        return { date, income, expense, balance: runningBalance };
      });

    const topExpenseCategories = (
      await this.categoryTotals(netExpenseByCategory(expensesByCategory), totalExpense)
    ).slice(0, 5);

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
  async getDailyBreakdown(userId: string, month?: string, filter: ResourceFilterDto = {}) {
    let year: number;
    let monthIndex: number;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      year = y;
      monthIndex = m - 1;
    } else {
      ({ year, monthIndex } = todaySaoPaulo());
    }
    const scoped = await this.resourceScope.resolve(userId, filter);

    const start = new Date(Date.UTC(year, monthIndex, 1));
    const end = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
    const daysInMonth = end.getUTCDate();

    const transactions = await this.prisma.transaction.findMany({
      where: {
        userId,
        ...scopeWhere(scoped),
        status: 'confirmed',
        type: { in: ['income', ...NET_EXPENSE_TYPES] },
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
      else if (t.type === 'expense') entry.expense += Number(t.amount);
      else entry.expense -= Number(t.amount);
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
  /** Categorias de despesa líquida, com nome e participação, da maior para a menor. */
  private async categoryTotals(byCategory: Map<string | null, number>, totalExpense: number) {
    const categoryIds = [...byCategory.keys()].filter(Boolean) as string[];
    const categories = await this.prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true, color: true },
    });
    const byId = new Map(categories.map((c) => [c.id, c]));
    return [...byCategory]
      .map(([categoryId, total]) => ({
        categoryId,
        categoryName: (categoryId && byId.get(categoryId)?.name) || 'Sem categoria',
        // A tela colore cada categoria igual em todos os gráficos.
        color: (categoryId && byId.get(categoryId)?.color) || null,
        total: roundCents(total),
        percentage: totalExpense > 0 ? (total / totalExpense) * 100 : 0,
      }))
      .filter((c) => c.total !== 0)
      .sort((a, b) => b.total - a.total);
  }

  private async getMonthlyComparison(
    userId: string,
    months: number,
    scoped: ScopedAccountIds = null,
  ) {
    // O mês corrente é o de São Paulo; `now` só serve para montar a grade.
    const today = todaySaoPaulo();
    const now = new Date(today.year, today.monthIndex, today.day);
    // Mesma janela do laço anterior: os `months` meses terminando no corrente.
    const first = startOfMonthUtc(today.year, today.monthIndex - (months - 1));
    const last = endOfMonthUtc(today.year, today.monthIndex);
    // Antes das bordas da janela, que o teste lê como os dois últimos parâmetros.
    const inScope = scoped ? Prisma.sql`AND "account_id" = ANY(${scoped}::text[])` : Prisma.empty;

    const rows = await this.prisma.$queryRaw<MonthlyTotalRow[]>`
      SELECT to_char(date_trunc('month', "transaction_date"), 'YYYY-MM') AS month,
             "type"::text AS type,
             sum("amount")::text AS total
        FROM "transactions"
       WHERE "user_id" = ${userId}
         AND "status" = 'confirmed'
         AND "type" IN ('income', 'expense', 'refund')
         ${inScope}
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
    const total = Number(row.total ?? 0);
    if (row.type === 'refund') series[index].expense = roundCents(series[index].expense - total);
    else series[index][row.type] = roundCents(series[index][row.type] + total);
  }

  return series;
}
