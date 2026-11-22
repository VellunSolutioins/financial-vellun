import type { DashboardService } from '../dashboard/dashboard.service';
import { roundCents } from '../transactions/net-expense';

type PersonalSummary = Awaited<ReturnType<DashboardService['getSummary']>>;
type BusinessSummary = Awaited<ReturnType<DashboardService['getBusinessSummary']>>;
type Receivables = Awaited<ReturnType<DashboardService['upcomingReceivables']>>;

/** Quantas contas a pagar o agente lista, as vencidas primeiro. */
const MAX_UPCOMING = 5;

export interface WhatsappSummaryItem {
  description: string;
  /** O que falta pagar. */
  remaining: number;
  /** Vencimento (YYYY-MM-DD). */
  dueDate: string;
  isOverdue: boolean;
  kind: 'bill' | 'invoice';
}

/** Receita prevista: o que ainda vai entrar. */
export interface WhatsappIncomeItem {
  description: string;
  /** O que falta receber. */
  remaining: number;
  /** Data prevista (YYYY-MM-DD). */
  dueDate: string;
  /** A data passou e o dinheiro não entrou. */
  isOverdue: boolean;
}

/**
 * Resumo enxuto para o agente de WhatsApp (docs/plans/018, Fase 1).
 *
 * Os números são **os mesmos do dashboard do app**, de cada perfil, para a
 * resposta no WhatsApp bater com a tela. O formato é estável e independe do
 * payload do dashboard, que muda com as telas.
 */
export interface WhatsappSummary {
  profileType: 'individual' | 'business';
  period: { start: string; end: string };
  /** Saldo nas contas hoje; nulo sem conta comum. */
  cashBalance: number | null;
  /** PF: gastos do mês (realizados). PJ: despesas do período. */
  spent: number;
  /** PF: gastos previstos ainda não pagos no período. PJ: não se aplica. */
  spentForecast: number | null;
  /** PF: receitas recebidas. PJ: receitas do período. */
  received: number;
  /** PF: a receber no período. PJ: tudo o que está a receber. */
  toReceive: number;
  /** Receitas menos gastos, na base de cada perfil. */
  result: number;
  /** Gasto por categoria, do maior para o menor. */
  byCategory: { name: string; total: number }[];
  /**
   * Se `byCategory` traz todas as categorias com gasto. O dashboard
   * empresarial só devolve as cinco maiores: ali, "não está na lista" não
   * quer dizer "não houve gasto".
   */
  byCategoryComplete: boolean;
  /**
   * Compromissos a partir de hoje. PF: até `until` (fim do mês corrente),
   * com faturas. PJ: tudo o que está em aberto (`until` nulo).
   */
  commitments: { until: string | null; toPay: number; overdue: number | null; toReceive: number };
  /** Contas a pagar em aberto (só despesas e faturas), vencidas primeiro. */
  upcoming: WhatsappSummaryItem[];
  /** Receitas previstas em aberto, atrasadas primeiro. */
  upcomingIncome: WhatsappIncomeItem[];
  /** Dívida nos cartões (só PF). */
  cardsDebt: number | null;
}

const day = (date: Date) => date.toISOString().slice(0, 10);

function incomeItem(
  item: {
    description: string | null;
    category?: { name: string } | null;
    amount: unknown;
    settledAmount: unknown;
    transactionDate: Date;
  },
  today: string,
): WhatsappIncomeItem {
  const dueDate = day(item.transactionDate);
  return {
    description: item.description || item.category?.name || 'Receita',
    remaining: roundCents(Number(item.amount) - Number(item.settledAmount)),
    dueDate,
    isOverdue: dueDate < today,
  };
}

export function fromPersonalSummary(
  s: PersonalSummary,
  receivables: Receivables,
  today: string,
): WhatsappSummary {
  const c = s.commitments;
  return {
    profileType: 'individual',
    period: s.period,
    cashBalance: s.cashBalance,
    spent: s.spending.realized,
    spentForecast: s.spending.forecast,
    received: s.income.received,
    toReceive: s.income.pending,
    result: s.result.value,
    byCategory: s.expensesByCategory
      .filter((category) => category.total > 0)
      .map((category) => ({ name: category.categoryName, total: category.total })),
    byCategoryComplete: true,
    commitments: {
      until: c.horizon,
      toPay: roundCents(
        c.overdueBills +
          c.overdueForecast +
          c.billsToHorizon +
          c.forecastToHorizon +
          c.invoicesOverdue +
          c.invoicesToHorizon,
      ),
      overdue: roundCents(c.overdueBills + c.overdueForecast + c.invoicesOverdue),
      toReceive: c.receivableToHorizon,
    },
    upcoming: s.upcomingBills.slice(0, MAX_UPCOMING).map((item) => ({
      description:
        item.description || (item.kind === 'transaction' && item.category?.name) || 'Conta',
      remaining: item.remaining,
      dueDate: day(item.transactionDate),
      isOverdue: item.isOverdue,
      kind: item.kind === 'invoice' ? 'invoice' : 'bill',
    })),
    upcomingIncome: receivables.slice(0, MAX_UPCOMING).map((item) => incomeItem(item, today)),
    cardsDebt: s.cards?.totalDebt ?? null,
  };
}

export function fromBusinessSummary(
  s: BusinessSummary,
  period: { start: string; end: string },
  today: string,
): WhatsappSummary {
  const upcoming = s.accountsPayable.items.slice(0, MAX_UPCOMING).map((item) => {
    const dueDate = day(item.transactionDate);
    return {
      description: item.description || item.category?.name || 'Conta',
      remaining: roundCents(Number(item.amount) - Number(item.settledAmount)),
      dueDate,
      isOverdue: dueDate < today,
      kind: 'bill' as const,
    };
  });
  return {
    profileType: 'business',
    period,
    cashBalance: s.totalBalance,
    spent: s.totalExpense,
    spentForecast: null,
    received: s.totalIncome,
    toReceive: s.accountsReceivable.total,
    result: roundCents(s.netResult),
    byCategory: s.topExpenseCategories
      .filter((category) => category.total > 0)
      .map((category) => ({ name: category.categoryName, total: category.total })),
    byCategoryComplete: false,
    commitments: {
      until: null,
      toPay: s.accountsPayable.total,
      // A prévia tem só cinco itens: somar as vencidas dela subestimaria o total.
      overdue: null,
      toReceive: s.accountsReceivable.total,
    },
    upcoming,
    upcomingIncome: s.accountsReceivable.items
      .slice(0, MAX_UPCOMING)
      .map((item) => incomeItem(item, today)),
    cardsDebt: null,
  };
}
