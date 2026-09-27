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

/** Situação de pagamento derivada dos valores (em centavos para não acumular erro). */
export function paymentStatus(totalCents: number, paidCents: number): PaymentStatus {
  const remaining = totalCents - paidCents;
  if (remaining < 0) return 'credit';
  if (remaining === 0) return 'paid';
  return paidCents > 0 ? 'partial' : 'unpaid';
}

export interface InvoiceAmounts<S extends InvoiceSpan = InvoiceSpan> {
  span: S;
  /** Compras e parcelas confirmadas. */
  chargesCents: number;
  /** Estornos (fase 4). */
  refundsCents: number;
  /** Pagamentos ativos (fase 4). */
  paymentsCents: number;
}

export interface CardPosition {
  /** Fatura aberta hoje (gravada ou só calculada, se ainda sem lançamento). */
  current: InvoiceSpan;
  currentTotalCents: number;
  currentRemainingCents: number;
  /** Cobranças em faturas que fecham depois da atual. */
  futureInstallmentsCents: number;
  /** Restante das faturas já fechadas e não quitadas. */
  closedUnpaidCents: number;
  /** Dívida total: tudo que foi cobrado desde o início do controle, menos estornos e pagamentos. */
  totalDebtCents: number;
  /** Pago acima do cobrado. */
  creditCents: number;
}

/**
 * Posição do cartão a partir das faturas com valores. `current` é a fatura que
 * contém hoje: a gravada, se existir, senão a que a configuração calcula.
 */
export function cardPosition<S extends InvoiceSpan>(
  invoices: readonly InvoiceAmounts<S>[],
  config: CycleConfig,
  today: CalendarDay,
): CardPosition {
  const current = cycleFor(
    today,
    config,
    invoices.map((i) => i.span),
  ).span;
  const net = (i: InvoiceAmounts<S>) => i.chargesCents - i.refundsCents - i.paymentsCents;

  let currentTotalCents = 0;
  let currentRemainingCents = 0;
  let futureInstallmentsCents = 0;
  let closedUnpaidCents = 0;
  let rawDebtCents = 0;
  for (const invoice of invoices) {
    rawDebtCents += net(invoice);
    if (invoice.span.referenceMonth === current.referenceMonth) {
      currentTotalCents = invoice.chargesCents - invoice.refundsCents;
      currentRemainingCents = net(invoice);
    } else if (cmp(invoice.span.closingDate, current.closingDate) > 0) {
      futureInstallmentsCents += invoice.chargesCents - invoice.refundsCents;
    } else if (cycleState(invoice.span, today) === 'closed') {
      closedUnpaidCents += Math.max(0, net(invoice));
    }
  }
  return {
    current,
    currentTotalCents,
    currentRemainingCents,
    futureInstallmentsCents,
    closedUnpaidCents,
    totalDebtCents: Math.max(0, rawDebtCents),
    creditCents: Math.max(0, -rawDebtCents),
  };
}

export function toCents(
  value: number | string | { toString(): string } | null | undefined,
): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value.toString()) * 100);
}
