import { Prisma } from '@prisma/client';

import {
  CalendarDay,
  calendarDayFromUtcDate,
  compareCalendarDays,
  dateOnlyString,
  startOfDayUtc,
  todaySaoPaulo,
} from '../common/date.util';
import { cents } from '../common/db';

/**
 * Estado de um lançamento quanto à liquidação (docs/adrs/0018). Nada aqui é
 * gravado: é derivado de valor, liquidado, previsão e vencimento.
 *
 * - `forecast`: previsão ainda não realizada (nem obrigação constituída);
 * - `open`: obrigação em aberto, nada pago;
 * - `partial`: parte paga, parte em aberto;
 * - `settled`: pago/recebido por inteiro (ou o restante foi dispensado);
 * - `on_card`: compra no cartão — quem liquida é o pagamento da fatura;
 * - `movement`: perna de transferência ou de pagamento de fatura, posição
 *   inicial — já é movimentação, não tem o que liquidar;
 * - `cancelled`.
 *
 * `isOverdue` é à parte: um lançamento em aberto (ou parcial, ou previsão)
 * com vencimento antes de hoje continua visível como vencido até ser pago,
 * cancelado ou dispensado. A passagem do tempo nunca o liquida.
 */
export type SettlementState =
  | 'forecast'
  | 'open'
  | 'partial'
  | 'settled'
  | 'on_card'
  | 'movement'
  | 'cancelled';

/** Tipos que podem ser liquidados (pagos/recebidos) em conta comum. */
export const SETTLEABLE_TYPES = ['income', 'expense', 'refund'] as const;

type StateInput = {
  type: string;
  status: string;
  amount: Prisma.Decimal | number | string;
  settledAmount: Prisma.Decimal | number | string;
  forecast: boolean;
  transactionDate: Date;
  account?: { type: string } | null;
};

export function settlementInfo(t: StateInput, today: CalendarDay = todaySaoPaulo()) {
  const amountCents = cents(t.amount);
  const settledCents = cents(t.settledAmount);
  const remainingCents = Math.max(0, amountCents - settledCents);
  const due = calendarDayFromUtcDate(t.transactionDate);

  let state: SettlementState;
  if (t.status === 'cancelled') state = 'cancelled';
  else if (!(SETTLEABLE_TYPES as readonly string[]).includes(t.type)) state = 'movement';
  else if (t.account?.type === 'credit_card') state = 'on_card';
  else if (remainingCents === 0) state = 'settled';
  else if (settledCents > 0) state = 'partial';
  else if (t.forecast) state = 'forecast';
  else state = 'open';

  const pending = state === 'open' || state === 'partial' || state === 'forecast';
  return {
    state,
    settledAmount: settledCents / 100,
    remaining: (pending ? remainingCents : 0) / 100,
    dueDate: dateOnlyString(due),
    isOverdue: pending && compareCalendarDays(due, today) < 0,
  };
}

/** Lançamento acrescido do estado de liquidação, na forma exposta pela API. */
export function withSettlementInfo<T extends StateInput>(t: T, today?: CalendarDay) {
  return { ...t, ...settlementInfo(t, today) };
}

/**
 * Gasto **realizado** (docs/adrs/0018): o fato já aconteceu (data do fato até
 * `endOfToday`) e não é uma previsão de conta comum ainda não paga. Cartão é
 * realizado na data do fato, inclusive assinatura. Mesmo critério do
 * dashboard, dos gráficos por recurso e de `GET /transactions/summary` com
 * `realizedOnly`.
 */
export function realizedWhere(endOfToday: Date): Prisma.TransactionWhereInput {
  return {
    eventDate: { lte: endOfToday },
    NOT: { forecast: true, settledAmount: 0, account: { type: { not: 'credit_card' } } },
  };
}

/**
 * Mês em que um gasto conta (docs/adrs/0019): a **parcela** no mês dela — uma
 * compra de R$ 1.000 em 5x pesa R$ 200 por mês no orçamento —; todo o resto na
 * data do fato. A dívida continua inteira desde a compra (o cartão lê o
 * `eventDate` da parcela, que segue sendo a data da compra).
 */
export function spendingPeriodWhere(start: Date, end: Date): Prisma.TransactionWhereInput {
  return {
    OR: [
      { recurrenceType: 'parcelado', ...budgetDateWhere({ gte: start, lte: end }) },
      { recurrenceType: { not: 'parcelado' }, eventDate: { gte: start, lte: end } },
    ],
  };
}

/**
 * Data em que um lançamento pesa nos gastos, pelo calendário de cobrança: o
 * `budgetDate` quando existe, senão a própria `transactionDate`. Só a parcela
 * 2+ no cartão tem `budgetDate` — ela é datada na abertura da fatura, e o gasto
 * continua contando uma parcela por mês a partir da compra (docs/adrs/0022).
 */
export function budgetDateWhere(range: Prisma.DateTimeFilter): Prisma.TransactionWhereInput {
  return { OR: [{ budgetDate: range }, { budgetDate: null, transactionDate: range }] };
}

/**
 * Gasto **realizado** na visão por parcela: a parcela de uma compra já feita
 * conta no mês dela (é compromisso firmado, não previsão); o resto segue
 * `realizedWhere`. Previsto = o que não passa aqui (compra com data futura,
 * previsão de conta comum ainda não paga).
 */
export function realizedSpendingFilter(endOfToday: Date): Prisma.TransactionWhereInput {
  return {
    OR: [
      { recurrenceType: 'parcelado', eventDate: { lte: endOfToday } },
      { recurrenceType: { not: 'parcelado' }, ...realizedWhere(endOfToday) },
    ],
  };
}

export type SettlementFilter = 'open' | 'partial' | 'settled' | 'overdue' | 'forecast';

/**
 * Filtro Prisma de estado de liquidação. `fields.amount` compara duas colunas
 * da mesma linha (`settled_amount < amount`) sem SQL cru.
 */
export function settlementWhere(
  filter: SettlementFilter,
  amountField: Prisma.FieldRef<'Transaction', 'Decimal'>,
): Prisma.TransactionWhereInput {
  const settleable: Prisma.TransactionWhereInput = {
    status: 'confirmed',
    type: { in: ['income', 'expense'] },
    account: { type: { not: 'credit_card' } },
  };
  const pending = { ...settleable, settledAmount: { lt: amountField } };
  const today = startOfDayUtc(dateOnlyString(todaySaoPaulo()));
  switch (filter) {
    case 'open':
      return pending;
    case 'partial':
      return { AND: [pending, { settledAmount: { gt: 0 } }] };
    case 'settled':
      return { ...settleable, settledAmount: { equals: amountField } };
    case 'overdue':
      return { ...pending, transactionDate: { lt: today } };
    case 'forecast':
      return { ...pending, forecast: true, settledAmount: 0 };
  }
}
