/**
 * Ciclo de fatura de cartão — funções puras sobre dias-calendário
 * (America/Sao_Paulo, como o resto do app). Nada aqui toca o banco.
 *
 * Regras (docs/adrs/0014-faturas-ciclos-e-limite.md):
 * - fechamento no mês M = `min(closingDay, últimoDia(M))`;
 * - vencimento = primeira data com dia `min(dueDay, últimoDia)` **depois** do
 *   fechamento;
 * - a fatura com fechamento F cobre compras de F_anterior até F − 1 dia — a
 *   compra no dia do fechamento vai para a fatura seguinte;
 * - identidade da fatura = `referenceMonth`, o `YYYY-MM` do vencimento.
 */
import { CalendarDay, compareCalendarDays } from '../common/date.util';
import { CardReconciliation, reconcileCard } from './card-reconciliation';

export interface CycleConfig {
  closingDay: number;
  dueDay: number;
}

export interface InvoiceSpan {
  referenceMonth: string;
  periodStart: CalendarDay;
  closingDate: CalendarDay;
  dueDate: CalendarDay;
}

export interface CycleResult<S extends InvoiceSpan> {
  /** A fatura (existente ou a criar) em que a data cai. */
  span: S | InvoiceSpan;
  /** `true` quando a fatura ainda não existe e deve ser criada. */
  isNew: boolean;
  /**
   * Só quando uma compra retroativa cai antes de uma fatura já gravada e o
   * ciclo calculado colidiria com ela: a fatura existente passa a começar aqui.
   */
  extendPeriodStartTo?: CalendarDay;
}

const cmp = compareCalendarDays;

export function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Dia `day` do mês (com `monthIndex` fora de 0–11 normalizado), limitado ao último dia. */
export function clampedDay(year: number, monthIndex: number, day: number): CalendarDay {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth();
  return { year: y, monthIndex: m, day: Math.min(day, lastDayOfMonth(y, m)) };
}

/** Fechamento no mês dado. */
export function closingDateIn(year: number, monthIndex: number, closingDay: number): CalendarDay {
  return clampedDay(year, monthIndex, closingDay);
}

/** Primeira data com o dia de vencimento estritamente depois do fechamento. */
export function dueDateAfter(closing: CalendarDay, dueDay: number): CalendarDay {
  const sameMonth = clampedDay(closing.year, closing.monthIndex, dueDay);
  if (cmp(sameMonth, closing) > 0) return sameMonth;
  return clampedDay(closing.year, closing.monthIndex + 1, dueDay);
}

export function referenceMonthOf(due: CalendarDay): string {
  return `${due.year}-${String(due.monthIndex + 1).padStart(2, '0')}`;
}

/** Fechamento, pela configuração, do ciclo em que cai uma compra na data. */
export function configClosingFor(date: CalendarDay, closingDay: number): CalendarDay {
  const sameMonth = closingDateIn(date.year, date.monthIndex, closingDay);
  return cmp(date, sameMonth) < 0
    ? sameMonth
    : closingDateIn(date.year, date.monthIndex + 1, closingDay);
}

/** O ciclo que a configuração dá para a data, sem considerar faturas gravadas. */
export function configCycleFor(date: CalendarDay, config: CycleConfig): InvoiceSpan {
  const closingDate = configClosingFor(date, config.closingDay);
  const periodStart = closingDateIn(
    closingDate.year,
    closingDate.monthIndex - 1,
    config.closingDay,
  );
  const dueDate = dueDateAfter(closingDate, config.dueDay);
  return { referenceMonth: referenceMonthOf(dueDate), periodStart, closingDate, dueDate };
}

export function spanContains(span: InvoiceSpan, date: CalendarDay): boolean {
  return cmp(span.periodStart, date) <= 0 && cmp(date, span.closingDate) < 0;
}

/**
 * Fatura em que cai uma compra na data.
 *
 * Faturas já gravadas mandam: suas datas não mudam. Fora delas, vale a
 * configuração atual, recortada para não sobrepor as gravadas — o ciclo começa
 * no fechamento da última gravada antes da data e termina no início da próxima.
 * Quando o vencimento do ciclo calculado cai no mesmo mês de uma fatura gravada
 * (transição após troca de fechamento/vencimento), o ciclo curto é absorvido
 * pelo seguinte, em vez de criar duas faturas com a mesma identidade.
 */
export function cycleFor<S extends InvoiceSpan>(
  date: CalendarDay,
  config: CycleConfig,
  existing: readonly S[],
): CycleResult<S> {
  const found = existing.find((s) => spanContains(s, date));
  if (found) return { span: found, isNew: false };

  let periodStart = configCycleFor(date, config).periodStart;
  for (const s of existing) {
    if (cmp(s.closingDate, date) <= 0 && cmp(s.closingDate, periodStart) > 0) {
      periodStart = s.closingDate;
    }
  }
  const nextExisting = existing
    .filter((s) => cmp(s.periodStart, date) > 0)
    .sort((a, b) => cmp(a.periodStart, b.periodStart))[0];

  let closingDate = configClosingFor(date, config.closingDay);
  for (let attempt = 0; attempt < 3; attempt++) {
    const truncated = nextExisting !== undefined && cmp(nextExisting.periodStart, closingDate) <= 0;
    if (truncated) closingDate = nextExisting.periodStart;

    const dueDate = dueDateAfter(closingDate, config.dueDay);
    const referenceMonth = referenceMonthOf(dueDate);
    const clash = existing.find((s) => s.referenceMonth === referenceMonth);
    if (!clash) {
      return { span: { referenceMonth, periodStart, closingDate, dueDate }, isNew: true };
    }
    if (truncated) {
      return { span: clash, isNew: false, extendPeriodStartTo: periodStart };
    }
    closingDate = closingDateIn(closingDate.year, closingDate.monthIndex + 1, config.closingDay);
  }
  throw new Error('Não foi possível determinar a fatura da compra');
}

/** Estado do ciclo: aberto até a véspera do fechamento. */
export function cycleState(span: InvoiceSpan, today: CalendarDay): 'open' | 'closed' {
  return cmp(today, span.closingDate) < 0 ? 'open' : 'closed';
}

export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'credit';

/**
 * Situação de pagamento derivada dos valores (em centavos para não acumular
 * erro). `remaining` é o restante já conciliado; `surplus`, o crédito que a
 * fatura gerou.
 */
export function paymentStatus(
  totalCents: number,
  paidCents: number,
  remainingCents = totalCents - paidCents,
  surplusCents = Math.max(0, paidCents - totalCents),
): PaymentStatus {
  if (surplusCents > 0) return 'credit';
  if (remainingCents <= 0) return 'paid';
  return remainingCents < totalCents ? 'partial' : 'unpaid';
}

export interface InvoiceAmounts<S extends InvoiceSpan = InvoiceSpan> {
  span: S;
  /** Compras e parcelas efetivas (data do fato até hoje). */
  chargesCents: number;
  /** Estornos. */
  refundsCents: number;
  /** Pagamentos ativos. */
  paymentsCents: number;
  /** Dívida da posição inicial (só na fatura anterior ao controle). */
  openingDebtCents?: number;
  /** Crédito da posição inicial. */
  openingCreditCents?: number;
  /** Cobranças previstas: assinatura ou compra com data do fato futura. */
  forecastCents?: number;
}

export interface CardPosition {
  /** Fatura aberta hoje (gravada ou só calculada, se ainda sem lançamento). */
  current: InvoiceSpan;
  /** Cobranças efetivas da fatura aberta, menos estornos. */
  currentTotalCents: number;
  /** O que falta pagar da fatura aberta, depois de pagamentos e créditos. */
  currentRemainingCents: number;
  /** Cobranças efetivas em faturas que fecham depois da atual (bruto). */
  futureChargesCents: number;
  /** O que falta pagar dessas faturas futuras, depois de pagamentos e créditos. */
  futureRemainingCents: number;
  /** Restante das faturas já fechadas e não quitadas. */
  closedUnpaidCents: number;
  /** Restante das faturas fechadas com vencimento já passado. */
  overdueCents: number;
  /** Cobranças previstas, fora da dívida. */
  forecastCents: number;
  /** Soma dos restantes, antes de aplicar créditos entre faturas. */
  grossDebtCents: number;
  /** Créditos aplicados entre faturas. */
  appliedCreditCents: number;
  /** Dívida líquida: o que falta pagar no cartão. */
  totalDebtCents: number;
  /** Saldo credor: crédito sem cobrança onde ser aplicado. */
  creditCents: number;
  reconciliation: CardReconciliation<InvoiceSpan & { id?: string }>;
}

/**
 * Posição do cartão a partir das faturas com valores, conciliadas por
 * `reconcileCard`: dívida, restante por fatura, futuras e vencidas saem todos
 * da mesma base. `current` é a fatura que contém hoje: a gravada, se existir,
 * senão a que a configuração calcula.
 */
export function cardPosition<S extends InvoiceSpan & { id?: string }>(
  invoices: readonly InvoiceAmounts<S>[],
  config: CycleConfig,
  today: CalendarDay,
): CardPosition {
  const current = cycleFor(
    today,
    config,
    invoices.map((i) => i.span),
  ).span;
  const reconciliation = reconcileCard(invoices);

  let currentTotalCents = 0;
  let currentRemainingCents = 0;
  let futureChargesCents = 0;
  let futureRemainingCents = 0;
  let closedUnpaidCents = 0;
  let overdueCents = 0;
  let forecastCents = 0;
  for (const row of reconciliation.invoices) {
    const { span } = row.invoice;
    forecastCents += row.invoice.forecastCents ?? 0;
    const totalCents =
      row.debitCents - row.invoice.refundsCents - (row.invoice.openingCreditCents ?? 0);
    if (span.referenceMonth === current.referenceMonth) {
      currentTotalCents = totalCents;
      currentRemainingCents = row.remainingCents;
    } else if (cmp(span.closingDate, current.closingDate) > 0) {
      futureChargesCents += totalCents;
      futureRemainingCents += row.remainingCents;
    } else if (cycleState(span, today) === 'closed') {
      closedUnpaidCents += row.remainingCents;
      if (cmp(span.dueDate, today) < 0) overdueCents += row.remainingCents;
    }
  }
  return {
    current,
    currentTotalCents,
    currentRemainingCents,
    futureChargesCents,
    futureRemainingCents,
    closedUnpaidCents,
    overdueCents,
    forecastCents,
    grossDebtCents: reconciliation.grossDebtCents,
    appliedCreditCents: reconciliation.appliedCreditCents,
    totalDebtCents: reconciliation.netDebtCents,
    creditCents: reconciliation.unappliedCreditCents,
    reconciliation,
  };
}

export function toCents(
  value: number | string | { toString(): string } | null | undefined,
): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value.toString()) * 100);
}
