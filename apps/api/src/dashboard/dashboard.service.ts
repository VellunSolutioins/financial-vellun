import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CASH_ACCOUNT_TYPES, REGULAR_ACCOUNT_WHERE } from '../accounts/account-types';
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
  compareCalendarDays,
  calendarDayFromUtcDate,
} from '../common/date.util';
import { cents } from '../common/db';
import { CardLedgerService, toDbDate } from '../credit-cards/card-ledger.service';
import { cardNeedsSetup } from '../credit-cards/card-setup';
import { cardPosition, cycleState } from '../credit-cards/invoice-cycle';
import {
  realizedSpendingFilter,
  settlementWhere,
  spendingPeriodWhere,
} from '../transactions/settlement-state';

/** Itens da lista "Próximas contas a pagar" do dashboard pessoal. */
const UPCOMING_BILLS_LIMIT = 5;
/**
 * Lançamentos lidos para montar a lista: com uma ocorrência por série, é
 * preciso ler além dos cinco — uma série mensal ocupa várias linhas seguidas.
 */
const UPCOMING_BILLS_SCAN = 60;

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
 * Base de data de cada visão do dashboard pessoal (docs/adrs/0018). A tela
 * mostra a base ao lado de cada número.
 */
export const DASHBOARD_BASES = {
  /** Gastos: a parcela no mês dela; o resto na data do fato (ADR 0019). */
  spending: 'installment_month',
  /** Receitas: data do fato, só o que foi recebido conta como realizado. */
  income: 'event_date_received',
  /** Fluxo de caixa: data do pagamento/recebimento e das transferências. */
  cashFlow: 'settlement_date',
  /** Compromissos: data de vencimento (parcela, conta, fatura). */
  commitments: 'due_date',
} as const;

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

/** Contas comuns ativas dentro do recorte: é delas o "saldo total" (PJ). */
function balanceAccountsWhere(userId: string, scoped: ScopedAccountIds) {
  return {
    userId,
    isActive: true,
    ...REGULAR_ACCOUNT_WHERE,
    ...(scoped ? { id: { in: scoped } } : {}),
  };
}

/**
 * Gasto **realizado**: o fato já aconteceu (data do fato até hoje) e não é uma
 * previsão de conta comum ainda não paga. A compra no cartão é realizada na
 * data dela, inclusive a assinatura (decisão 2 da ADR 0018); a parcela, na
 * data da compra. Estorno conta com sinal negativo.
 */
function realizedSpendingWhere(
  start: Date,
  end: Date,
  endOfToday: Date,
): Prisma.TransactionWhereInput {
  return {
    AND: [
      realizedSpendingFilter(endOfToday),
      { status: 'confirmed', type: { in: [...NET_EXPENSE_TYPES] } },
      spendingPeriodWhere(start, end),
    ],
  };
}

/**
 * Gasto **previsto** no período: o que cai no período mas ainda não é
 * realizado — compra com data futura (e as parcelas dela), previsão de conta
 * comum ainda não paga.
 */
function forecastSpendingWhere(
  start: Date,
  end: Date,
  endOfToday: Date,
): Prisma.TransactionWhereInput {
  return {
    AND: [
      { status: 'confirmed', type: 'expense' },
      spendingPeriodWhere(start, end),
      { NOT: realizedSpendingFilter(endOfToday) },
    ],
  };
}

const openCents = (row: {
  _sum: { amount: Prisma.Decimal | null; settledAmount: Prisma.Decimal | null };
}) => cents(row._sum.amount) - cents(row._sum.settledAmount);

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private resourceScope: ResourceScope = new ResourceScope(prisma),
    private cardLedger: CardLedgerService = new CardLedgerService(prisma),
  ) {}

  /**
   * Posição conciliada dos cartões do recorte (todos, inclusive arquivados:
   * arquivar não apaga dívida). `null` quando o recorte não tem cartão.
   */
  private async cardsPosition(userId: string, scoped: ScopedAccountIds) {
    const cards = await this.prisma.creditCard.findMany({
      where: { account: { userId, ...(scoped ? { id: { in: scoped } } : {}) } },
      include: { account: { select: { name: true, isActive: true } } },
    });
    if (cards.length === 0) return null;
    const configured = cards.filter((c) => !cardNeedsSetup(c));
    const amounts = await this.cardLedger.invoicesWithAmounts(configured.map((c) => c.id));
    const today = todaySaoPaulo();
    const positions = configured.map((card) => ({
      card,
      position: cardPosition(
        amounts.get(card.id) ?? [],
        { closingDay: card.closingDay!, dueDay: card.dueDay! },
        today,
      ),
    }));
    const sum = (pick: (p: (typeof positions)[number]['position']) => number) =>
      positions.reduce((total, p) => total + pick(p.position), 0) / 100;
    return {
      positions,
      summary: {
        /** Dívida efetiva (depois de pagamentos e créditos), todos os cartões configurados. */
        totalDebt: sum((p) => p.totalDebtCents),
        /** Restante de faturas fechadas com vencimento passado. */
        overdue: sum((p) => p.overdueCents),
        /** Restante da fatura aberta + fechadas a vencer. */
        currentAndClosed: sum(
          (p) => p.currentRemainingCents + p.closedUnpaidCents - p.overdueCents,
        ),
        /** O que falta pagar de faturas futuras (parcelas já compradas). */
        futureInstallments: sum((p) => p.futureRemainingCents),
        /** Saldo credor: crédito sem cobrança onde ser aplicado. */
        creditBalance: sum((p) => p.creditCents),
        /** Assinaturas e compras futuras previstas: não são dívida. */
        forecast: sum((p) => p.forecastCents),
        /** Cartões sem configuração: a dívida deles é desconhecida, não zero. */
        incompleteCards: cards.length - configured.length,
        cardCount: cards.length,
      },
    };
  }

  /**
   * "Próximas contas a pagar": o que sai do bolso em seguida, vencido primeiro.
   *
   * - Despesas de conta comum **em aberto** (não pagas, ou pagas em parte), com
   *   **uma ocorrência por série**: a mais antiga em aberto. As vencidas
   *   continuam aqui até serem pagas, canceladas ou dispensadas — vencer não
   *   paga nada.
   * - Compras no cartão não entram uma a uma: o que se paga é a fatura. Cada
   *   fatura com restante **conciliado** (depois de pagamentos e créditos de
   *   outras faturas) — a aberta hoje e as fechadas — vira um item com o
   *   restante e o vencimento. Faturas futuras ficam de fora.
   */
  private async upcomingBills(
    userId: string,
    scoped: ScopedAccountIds,
    cards: Awaited<ReturnType<DashboardService['cardsPosition']>>,
  ) {
    const today = todaySaoPaulo();
    const transactions = await this.prisma.transaction.findMany({
      where: {
        userId,
        ...scopeWhere(scoped),
        type: 'expense',
        ...settlementWhere('open', this.prisma.transaction.fields.amount),
      },
      include: { category: true, account: true },
      orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }],
      take: UPCOMING_BILLS_SCAN,
    });

    const seenSeries = new Set<string>();
    const transactionItems = transactions
      .filter((t) => {
        if (!t.seriesId) return true;
        if (seenSeries.has(t.seriesId)) return false;
        seenSeries.add(t.seriesId);
        return true;
      })
      .map((t) => ({
        ...t,
        kind: 'transaction' as const,
        /** O que falta pagar. */
        remaining: (cents(t.amount) - cents(t.settledAmount)) / 100,
        isOverdue: compareCalendarDays(calendarDayFromUtcDate(t.transactionDate), today) < 0,
      }));

    const invoiceItems = (cards?.positions ?? []).flatMap(({ card, position }) =>
      position.reconciliation.invoices
        .filter(
          (row) =>
            compareCalendarDays(row.invoice.span.closingDate, position.current.closingDate) <= 0 &&
            row.remainingCents > 0,
        )
        .map((row) => ({
          kind: 'invoice' as const,
          id: row.invoice.span.id ?? row.invoice.span.referenceMonth,
          cardId: card.id,
          description: `Fatura ${card.account.name}`,
          amount: row.remainingCents / 100,
          remaining: row.remainingCents / 100,
          /** Vencimento da fatura (mesmo nome dos lançamentos, para a lista ser uma só). */
          transactionDate: toDbDate(row.invoice.span.dueDate),
          invoiceState: cycleState(row.invoice.span, today),
          isOverdue: compareCalendarDays(row.invoice.span.dueDate, today) < 0,
          category: null,
        })),
    );

    return [...transactionItems, ...invoiceItems]
      .sort((a, b) => a.transactionDate.getTime() - b.transactionDate.getTime())
      .slice(0, UPCOMING_BILLS_LIMIT);
  }

  /**
   * Visão pessoal (docs/adrs/0018). Cada número tem nome, fórmula e base de
   * data próprios (`bases`); nenhum mistura compra e parcela, nem realizado e
   * previsto:
   *
   * - **Saldo em contas** (`cashBalance`): soma das contas de caixa ativas do
   *   recorte, hoje; não depende do período. `null` se o recorte não tem conta
   *   de caixa (ex.: só um cartão) — zero não seria uma medida útil.
   * - **Gastos por data da compra** (`spending`): realizado e previsto, líquido
   *   de estornos, com consumo separado de aquisições e juros/tarifas.
   * - **Receitas** (`income`): recebidas (o que entrou) e a receber.
   * - **Resultado do período** (`result`) = receitas recebidas − gastos
   *   realizados. Substitui a antiga "Economia", que somava parcelas pela data
   *   delas e lançamentos futuros.
   * - **Fluxo de caixa** (`cashFlow`): o que entrou e saiu das contas de caixa no
   *   período, pela data do pagamento.
   * - **Compromissos** (`commitments`), por vencimento, a partir de hoje.
   * - **Cartões** (`cards`): dívida efetiva, vencidas, saldo credor.
   * - **Saldo projetado** (`projected`) até o fim do mês corrente, com cada
   *   componente descontado — não é saldo bancário nem patrimônio.
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
    const today = todaySaoPaulo();
    const startOfToday = startOfDayUtc(dateOnlyString(today));
    const endOfToday = endOfDayUtc(dateOnlyString(today));
    const horizon = endOfMonthUtc(today.year, today.monthIndex);

    const regularAccounts = await this.prisma.account.findMany({
      where: { userId, ...REGULAR_ACCOUNT_WHERE, ...(scoped ? { id: { in: scoped } } : {}) },
      select: { id: true, type: true, isActive: true, currentBalance: true },
    });
    const cashAccounts = regularAccounts.filter((a) =>
      (CASH_ACCOUNT_TYPES as readonly string[]).includes(a.type),
    );
    const cashIds = cashAccounts.map((a) => a.id);
    const balanceOf = (list: typeof regularAccounts) =>
      list.filter((a) => a.isActive).reduce((sum, a) => sum + cents(a.currentBalance), 0) / 100;

    const realized = realizedSpendingWhere(start, end, endOfToday);
    const [
      realizedByType,
      realizedByCategory,
      forecastAgg,
      incomeAgg,
      recentTransactions,
      cards,
      cashFlow,
    ] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: { userId, ...inScope, ...realized },
        _sum: { amount: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['categoryId', 'type'],
        where: { userId, ...inScope, ...realized },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { userId, ...inScope, ...forecastSpendingWhere(start, end, endOfToday) },
        _sum: { amount: true, settledAmount: true },
      }),
      this.prisma.transaction.aggregate({
        where: {
          userId,
          ...inScope,
          type: 'income',
          status: 'confirmed',
          eventDate: { gte: start, lte: end },
        },
        _sum: { amount: true, settledAmount: true },
      }),
      this.prisma.transaction.findMany({
        where: { userId, ...inScope },
        include: { category: true, account: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.cardsPosition(userId, scoped),
      this.cashFlow(userId, cashIds, start, end),
    ]);

    const spendingRealized = roundCents(netExpenseOf(realizedByType));
    const byCategory = await this.categoryTotals(
      netExpenseByCategory(realizedByCategory),
      spendingRealized,
    );
    const byNature = { consumption: 0, asset_acquisition: 0, financial_cost: 0 };
    for (const c of byCategory) byNature[c.nature] = roundCents(byNature[c.nature] + c.total);
    const incomeReceived = cents(incomeAgg._sum.settledAmount) / 100;
    const incomePending = openCents(incomeAgg) / 100;

    const commitments = await this.commitments(userId, scoped, startOfToday, horizon, cards);
    const cashBalance = cashAccounts.length > 0 ? balanceOf(cashAccounts) : null;
    const resultValue = roundCents(incomeReceived - spendingRealized);

    const [monthlyComparison, lastEntry, upcomingBills] = await Promise.all([
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
      this.upcomingBills(userId, scoped, cards),
    ]);
    const lastDate = lastEntry._max.transactionDate;

    const projected =
      cashBalance === null
        ? null
        : {
            /** Até quando os compromissos foram descontados (fim do mês corrente). */
            horizon: horizon.toISOString().slice(0, 10),
            /** Saldo em contas + a receber − a pagar até o horizonte (inclui vencidos). */
            value: roundCents(
              cashBalance +
                commitments.receivableToHorizon -
                commitments.overdueBills -
                commitments.billsToHorizon -
                commitments.forecastToHorizon -
                (commitments.invoicesOverdue + commitments.invoicesToHorizon),
            ),
            components: {
              cashBalance,
              receivable: commitments.receivableToHorizon,
              overdueBills: commitments.overdueBills,
              bills: commitments.billsToHorizon,
              forecastBills: commitments.forecastToHorizon,
              invoices: roundCents(commitments.invoicesOverdue + commitments.invoicesToHorizon),
            },
          };

    return {
      period: {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      },
      bases: DASHBOARD_BASES,
      /** Saldo atual em contas de caixa (sem investimentos nem empréstimos). Independe do período. */
      cashBalance,
      /** Saldo das contas de investimento do recorte. */
      investmentsBalance: balanceOf(regularAccounts.filter((a) => a.type === 'investment')),
      /** Dívida das contas de empréstimo/financiamento (saldo negativo, em positivo). */
      loansDebt: Math.max(0, -balanceOf(regularAccounts.filter((a) => a.type === 'loan'))),
      spending: {
        realized: spendingRealized,
        forecast: openCents(forecastAgg) / 100,
        byNature,
      },
      income: {
        received: incomeReceived,
        pending: incomePending,
      },
      result: {
        value: resultValue,
        /** Resultado ÷ receitas recebidas, em %; nulo sem receita recebida. */
        percentOfIncome: incomeReceived > 0 ? (resultValue / incomeReceived) * 100 : null,
      },
      cashFlow,
      commitments,
      cards: cards?.summary ?? null,
      projected,
      expensesByCategory: byCategory,
      recentTransactions,
      upcomingBills,
      monthlyComparison,
      /** `YYYY-MM` do último lançamento confirmado (pode ser futuro); nulo se não há nenhum. */
      lastEntryMonth: lastDate ? lastDate.toISOString().slice(0, 7) : null,
    };
  }

  /**
   * Compromissos por vencimento, a partir de hoje (independem do período):
   * contas de conta comum em aberto vencidas e a vencer até o horizonte, as
   * previsões a vencer, o que há a receber e as faturas (restante conciliado).
   */
  private async commitments(
    userId: string,
    scoped: ScopedAccountIds,
    startOfToday: Date,
    horizon: Date,
    cards: Awaited<ReturnType<DashboardService['cardsPosition']>>,
  ) {
    const amountField = this.prisma.transaction.fields.amount;
    const open = { userId, ...scopeWhere(scoped), ...settlementWhere('open', amountField) };
    const sumOpen = (where: Prisma.TransactionWhereInput) =>
      this.prisma.transaction
        .aggregate({ where: { ...open, ...where }, _sum: { amount: true, settledAmount: true } })
        .then((row) => openCents(row) / 100);

    const [overdueBills, overdueForecast, billsToHorizon, forecastToHorizon, receivableToHorizon] =
      await Promise.all([
        sumOpen({ type: 'expense', forecast: false, transactionDate: { lt: startOfToday } }),
        sumOpen({ type: 'expense', forecast: true, transactionDate: { lt: startOfToday } }),
        sumOpen({
          type: 'expense',
          forecast: false,
          transactionDate: { gte: startOfToday, lte: horizon },
        }),
        sumOpen({
          type: 'expense',
          forecast: true,
          transactionDate: { gte: startOfToday, lte: horizon },
        }),
        sumOpen({ type: 'income', transactionDate: { lte: horizon } }),
      ]);

    let invoicesOverdue = 0;
    let invoicesToHorizon = 0;
    const today = todaySaoPaulo();
    const horizonDay = calendarDayFromUtcDate(horizon);
    for (const { position } of cards?.positions ?? []) {
      for (const row of position.reconciliation.invoices) {
        if (row.remainingCents === 0) continue;
        const due = row.invoice.span.dueDate;
        if (compareCalendarDays(due, today) < 0) invoicesOverdue += row.remainingCents;
        else if (compareCalendarDays(due, horizonDay) <= 0) invoicesToHorizon += row.remainingCents;
      }
    }

    return {
      horizon: horizon.toISOString().slice(0, 10),
      /** Contas (obrigações firmadas) vencidas e não pagas. */
      overdueBills,
      /** Previsões cuja data passou sem pagamento: confirme, pague ou cancele. */
      overdueForecast,
      /** Contas a vencer até o horizonte. */
      billsToHorizon,
      /** Previsões (ex.: assinaturas em conta) a vencer até o horizonte. */
      forecastToHorizon,
      /** A receber até o horizonte (inclui o que já devia ter entrado). */
      receivableToHorizon,
      /** Faturas vencidas e não pagas (restante conciliado). */
      invoicesOverdue: invoicesOverdue / 100,
      /** Faturas a vencer até o horizonte. */
      invoicesToHorizon: invoicesToHorizon / 100,
    };
  }

  /**
   * Fluxo de caixa realizado das contas de caixa no período, pela data em que
   * o dinheiro se moveu: recebimentos e pagamentos (liquidações), pagamentos de
   * fatura e transferências. Transferência entre duas contas de caixa se anula.
   */
  private async cashFlow(userId: string, cashIds: string[], start: Date, end: Date) {
    if (cashIds.length === 0) {
      return { inflow: 0, outflow: 0, invoicePayments: 0, transfersNet: 0, net: 0 };
    }
    const first = start.toISOString().slice(0, 10);
    const last = end.toISOString().slice(0, 10);
    const [settled, legs] = await Promise.all([
      this.prisma.$queryRaw<{ type: string; total: string | null }[]>`
        SELECT t."type"::text AS type, SUM(s."amount")::text AS total
          FROM "transaction_settlements" s
          JOIN "transactions" t ON t."id" = s."transaction_id"
         WHERE s."user_id" = ${userId}
           AND s."status" = 'active'
           AND s."kind" = 'payment'
           AND s."account_id" = ANY(${cashIds}::text[])
           AND t."status" = 'confirmed'
           AND s."settled_on" >= ${first}::date
           AND s."settled_on" <= ${last}::date
         GROUP BY 1
      `,
      this.prisma.transaction.groupBy({
        by: ['transferDirection', 'cardPaymentId'],
        where: {
          userId,
          accountId: { in: cashIds },
          type: 'transfer',
          status: 'confirmed',
          transferDirection: { not: null },
          transactionDate: { gte: start, lte: end },
        },
        _sum: { amount: true },
      }),
    ]);
    const settledOf = (type: string) => cents(settled.find((r) => r.type === type)?.total);
    let invoicePayments = 0;
    let transfersNet = 0;
    for (const leg of legs) {
      const amount = cents(leg._sum.amount);
      if (leg.cardPaymentId) invoicePayments += leg.transferDirection === 'out' ? amount : -amount;
      else transfersNet += leg.transferDirection === 'in' ? amount : -amount;
    }
    const inflow = settledOf('income') + settledOf('refund');
    const outflow = settledOf('expense');
    return {
      /** Recebimentos e estornos que entraram. */
      inflow: inflow / 100,
      /** Pagamentos de contas e compras à vista. */
      outflow: outflow / 100,
      /** Pagamentos de fatura de cartão. */
      invoicePayments: invoicePayments / 100,
      /** Transferências com contas fora do caixa (aporte, resgate, empréstimo). */
      transfersNet: transfersNet / 100,
      /** Variação do caixa no período. */
      net: (inflow - outflow - invoicePayments + transfersNet) / 100,
    };
  }

  /**
   * Visão empresarial (fora do escopo do modelo pessoal — só adaptada para
   * continuar correta, docs/adrs/0018). Receita, despesa e categorias por
   * competência; o fluxo de caixa vem das movimentações reais (liquidações e
   * transferências); a pagar/receber é o que está **em aberto**, inclusive o
   * vencido — antes era "data de hoje em diante" e uma conta vencida sumia.
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
    const pending = settlementWhere('open', this.prisma.transaction.fields.amount);

    const [
      accounts,
      confirmedInPeriod,
      expensesByCategory,
      accountsReceivable,
      accountsPayable,
      pendingTotals,
      settledInPeriod,
      legsInPeriod,
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
          type: { in: ['income', 'expense', 'refund'] },
          transactionDate: { gte: start, lte: end },
        },
        select: { type: true, amount: true },
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
        where: { userId, ...inScope, type: 'income', ...pending },
        include: { category: true, account: true },
        orderBy: { transactionDate: 'asc' },
        take: PENDING_PREVIEW_LIMIT,
      }),
      this.prisma.transaction.findMany({
        where: { userId, ...inScope, type: 'expense', ...pending },
        include: { category: true, account: true },
        orderBy: { transactionDate: 'asc' },
        take: PENDING_PREVIEW_LIMIT,
      }),
      // Os totais não podem sair da prévia acima: uma soma de cinco itens
      // mostraria "R$ 1.200 a receber" com R$ 80 mil em aberto. Uma agregação
      // só cobre receber e pagar, e é ela que conta quantos existem.
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: { userId, ...inScope, ...pending, type: { in: ['income', 'expense'] } },
        _sum: { amount: true, settledAmount: true },
        _count: { _all: true },
      }),
      this.prisma.transactionSettlement.findMany({
        where: {
          userId,
          status: 'active',
          kind: 'payment',
          settledOn: { gte: start, lte: end },
          ...(scoped ? { accountId: { in: scoped } } : {}),
          transaction: { status: 'confirmed' },
        },
        select: { amount: true, settledOn: true, transaction: { select: { type: true } } },
      }),
      this.prisma.transaction.findMany({
        where: {
          userId,
          ...inScope,
          status: 'confirmed',
          type: 'transfer',
          transferDirection: { not: null },
          transactionDate: { gte: start, lte: end },
          account: { type: { not: 'credit_card' } },
        },
        select: { amount: true, transactionDate: true, transferDirection: true },
      }),
    ]);

    const totalBalance = accounts.reduce((sum, a) => sum + Number(a.currentBalance), 0);

    let totalIncome = 0;
    let totalExpense = 0;
    for (const t of confirmedInPeriod) {
      const amount = Number(t.amount);
      // Competência: receita e despesa líquida de estornos.
      if (t.type === 'income') totalIncome += amount;
      else if (t.type === 'expense') totalExpense += amount;
      else if (t.type === 'refund') totalExpense -= amount;
    }
    totalExpense = roundCents(totalExpense);

    // Caixa: o que de fato se moveu nas contas comuns — recebimentos e
    // estornos entram, pagamentos e transferências que saem saem.
    const dailyMap = new Map<string, { income: number; expense: number }>();
    const addDay = (date: Date, income: number, expense: number) => {
      const day = date.toISOString().slice(0, 10);
      const entry = dailyMap.get(day) ?? { income: 0, expense: 0 };
      entry.income += income;
      entry.expense += expense;
      dailyMap.set(day, entry);
    };
    for (const s of settledInPeriod) {
      const amount = Number(s.amount);
      if (s.transaction.type === 'expense') addDay(s.settledOn, 0, amount);
      else addDay(s.settledOn, amount, 0);
    }
    for (const leg of legsInPeriod) {
      const amount = Number(leg.amount);
      if (leg.transferDirection === 'in') addDay(leg.transactionDate, amount, 0);
      else addDay(leg.transactionDate, 0, amount);
    }

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
        total: receivableAgg ? openCents(receivableAgg) / 100 : 0,
        // `count` é o total em aberto; `items` é só a prévia. O widget precisa
        // dos dois para não dar a entender que há apenas cinco.
        count: receivableAgg?._count._all ?? 0,
        items: accountsReceivable,
      },
      accountsPayable: {
        total: payableAgg ? openCents(payableAgg) / 100 : 0,
        count: payableAgg?._count._all ?? 0,
        items: accountsPayable,
      },
    };
  }

  /**
   * Série diária de um mês, nas mesmas bases do resumo: gastos realizados pela
   * data da compra (líquidos de estorno) e receitas recebidas pela data do
   * fato. Um ponto por dia (zero quando não há). ``month`` no formato
   * ``YYYY-MM``; sem ele, o mês atual.
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
    const endOfToday = endOfDayUtc(dateOnlyString(todaySaoPaulo()));

    const [expenses, incomes] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { userId, ...scopeWhere(scoped), ...realizedSpendingWhere(start, end, endOfToday) },
        select: {
          type: true,
          amount: true,
          eventDate: true,
          transactionDate: true,
          recurrenceType: true,
        },
      }),
      this.prisma.transaction.findMany({
        where: {
          userId,
          ...scopeWhere(scoped),
          type: 'income',
          status: 'confirmed',
          eventDate: { gte: start, lte: end },
          settledAmount: { gt: 0 },
        },
        select: { settledAmount: true, eventDate: true },
      }),
    ]);

    const byDay = new Map<number, { income: number; expense: number }>();
    for (let d = 1; d <= daysInMonth; d++) byDay.set(d, { income: 0, expense: 0 });

    for (const t of expenses) {
      // A parcela no dia dela; o resto na data do fato (ADR 0019).
      const day = t.recurrenceType === 'parcelado' ? t.transactionDate : t.eventDate;
      const entry = byDay.get(day.getUTCDate());
      if (!entry) continue;
      if (t.type === 'expense') entry.expense += Number(t.amount);
      else entry.expense -= Number(t.amount);
    }
    for (const t of incomes) {
      const entry = byDay.get(t.eventDate.getUTCDate());
      if (entry) entry.income += Number(t.settledAmount);
    }

    return {
      month: start.toISOString().slice(0, 7),
      days: [...byDay.entries()].map(([day, v]) => ({
        day,
        income: roundCents(v.income),
        expense: roundCents(v.expense),
      })),
    };
  }

  /** Categorias de despesa líquida, com nome, natureza e participação, da maior para a menor. */
  private async categoryTotals(byCategory: Map<string | null, number>, totalExpense: number) {
    const categoryIds = [...byCategory.keys()].filter(Boolean) as string[];
    const categories = await this.prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true, color: true, nature: true },
    });
    const byId = new Map(categories.map((c) => [c.id, c]));
    return [...byCategory]
      .map(([categoryId, total]) => ({
        categoryId,
        categoryName: (categoryId && byId.get(categoryId)?.name) || 'Sem categoria',
        // A tela colore cada categoria igual em todos os gráficos.
        color: (categoryId && byId.get(categoryId)?.color) || null,
        nature: (categoryId && byId.get(categoryId)?.nature) || ('consumption' as const),
        total: roundCents(total),
        percentage: totalExpense > 0 ? (total / totalExpense) * 100 : 0,
      }))
      .filter((c) => c.total !== 0)
      .sort((a, b) => b.total - a.total);
  }

  /**
   * Receitas recebidas e gastos realizados por mês, nos últimos `months`
   * meses — as mesmas bases do resumo: a parcela no mês dela (ADR 0019), o
   * resto na data do fato; receita só o que foi recebido.
   *
   * Uma query: antes eram duas agregações por mês, em série — 24 idas ao
   * banco para montar um gráfico. `$queryRaw` porque o `groupBy` do Prisma não
   * expressa `date_trunc`. O `userId` vai como parâmetro; os enums entram como
   * literal, que o Postgres coage para o tipo da coluna.
   *
   * Meses sem lançamento **não** voltam do banco, e o gráfico precisa deles
   * como zero: a grade dos meses é montada aqui, e o resultado do banco só a
   * preenche.
   */
  private async getMonthlyComparison(
    userId: string,
    months: number,
    scoped: ScopedAccountIds = null,
  ) {
    // O mês corrente é o de São Paulo; `now` só serve para montar a grade.
    const today = todaySaoPaulo();
    const now = new Date(today.year, today.monthIndex, today.day);
    const first = startOfMonthUtc(today.year, today.monthIndex - (months - 1));
    const last = endOfMonthUtc(today.year, today.monthIndex);
    // Antes das bordas da janela, que o teste lê como os dois últimos parâmetros.
    const inScope = scoped ? Prisma.sql`AND t."account_id" = ANY(${scoped}::text[])` : Prisma.empty;

    // Mês do gasto: a parcela no dela, o resto na data do fato (ADR 0019).
    const budgetDate = Prisma.sql`(CASE WHEN t."recurrence_type" = 'parcelado' THEN t."transaction_date" ELSE t."event_date" END)`;
    const rows = await this.prisma.$queryRaw<MonthlyTotalRow[]>`
      SELECT to_char(date_trunc('month', ${budgetDate}), 'YYYY-MM') AS month,
             t."type"::text AS type,
             sum(CASE WHEN t."type" = 'income' THEN t."settled_amount" ELSE t."amount" END)::text AS total
        FROM "transactions" t
        JOIN "accounts" a ON a."id" = t."account_id"
       WHERE t."user_id" = ${userId}
         AND t."status" = 'confirmed'
         AND t."type" IN ('income', 'expense', 'refund')
         AND t."event_date" <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
         AND NOT (t."recurrence_type" <> 'parcelado' AND t."type" = 'expense' AND t."forecast" AND t."settled_amount" = 0 AND a."type" <> 'credit_card')
         ${inScope}
         AND ${budgetDate} >= ${first.toISOString().slice(0, 10)}::date
         AND ${budgetDate} <= ${last.toISOString().slice(0, 10)}::date
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
