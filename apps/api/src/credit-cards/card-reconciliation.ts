/**
 * Conciliação das faturas de **um** cartão — função pura, sem banco.
 *
 * Regra (docs/adrs/0018):
 * - Cada fatura tem débitos (cobranças efetivas + dívida inicial) e créditos
 *   próprios (estornos + crédito inicial + pagamentos ativos).
 * - O que sobra de crédito numa fatura (pagou ou estornou mais do que ela
 *   cobrou) é **crédito com origem nela**.
 * - Os créditos são aplicados às faturas com restante, da que vence primeiro
 *   para a última, consumindo primeiro o crédito mais antigo. É uma convenção
 *   do app: a operadora pode aplicar em outra ordem, mas o total é o mesmo.
 * - Nada é compensado em silêncio: cada aplicação sai na lista, com a fatura de
 *   origem e a de destino. Como tudo é derivado dos lançamentos e pagamentos,
 *   reverter um pagamento desfaz a aplicação sem nenhum registro a corrigir.
 * - Cartões diferentes nunca se compensam: a função recebe um cartão só.
 */
import { CalendarDay, compareCalendarDays } from '../common/date.util';
import type { InvoiceAmounts, InvoiceSpan } from './invoice-cycle';

export interface CreditApplication {
  fromInvoiceId: string;
  fromReferenceMonth: string;
  toInvoiceId: string;
  toReferenceMonth: string;
  cents: number;
}

export interface ReconciledInvoice<S extends InvoiceSpan & { id?: string }> {
  invoice: InvoiceAmounts<S>;
  /** Débitos da fatura: cobranças efetivas + dívida inicial. */
  debitCents: number;
  /** Créditos da própria fatura: estornos + crédito inicial + pagamentos. */
  ownCreditCents: number;
  /** Restante antes de aplicar crédito de outras faturas (≥ 0). */
  grossRemainingCents: number;
  /** Créditos vindos de outras faturas, com a origem. */
  creditsApplied: CreditApplication[];
  /** O que ainda falta pagar, depois dos créditos (≥ 0). */
  remainingCents: number;
  /** Crédito que a fatura gerou (pagamento ou estorno acima do cobrado). */
  surplusCents: number;
  /** Para onde esse crédito foi. */
  surplusAppliedTo: CreditApplication[];
  /** Parte do crédito desta fatura que ainda não achou onde ser aplicada. */
  unappliedSurplusCents: number;
}

export interface CardReconciliation<S extends InvoiceSpan & { id?: string }> {
  invoices: ReconciledInvoice<S>[];
  /** Soma dos restantes antes da aplicação de créditos. */
  grossDebtCents: number;
  /** Soma dos créditos aplicados entre faturas. */
  appliedCreditCents: number;
  /** Dívida líquida: o que falta pagar no cartão. */
  netDebtCents: number;
  /** Saldo credor: crédito que não tem cobrança onde ser aplicado. */
  unappliedCreditCents: number;
  /** Aplicações, na ordem em que foram feitas. */
  applications: CreditApplication[];
}

const idOf = (span: InvoiceSpan & { id?: string }) => span.id ?? span.referenceMonth;

function byDueDate(a: InvoiceSpan, b: InvoiceSpan) {
  return (
    compareCalendarDays(a.dueDate, b.dueDate) ||
    compareCalendarDays(a.closingDate, b.closingDate) ||
    a.referenceMonth.localeCompare(b.referenceMonth)
  );
}

export function debitCentsOf(invoice: InvoiceAmounts) {
  return invoice.chargesCents + (invoice.openingDebtCents ?? 0);
}

export function ownCreditCentsOf(invoice: InvoiceAmounts) {
  return invoice.refundsCents + (invoice.openingCreditCents ?? 0) + invoice.paymentsCents;
}

export function reconcileCard<S extends InvoiceSpan & { id?: string }>(
  invoices: readonly InvoiceAmounts<S>[],
): CardReconciliation<S> {
  const ordered = [...invoices].sort((a, b) => byDueDate(a.span, b.span));
  const rows: ReconciledInvoice<S>[] = ordered.map((invoice) => {
    const debitCents = debitCentsOf(invoice);
    const ownCreditCents = ownCreditCentsOf(invoice);
    const net = debitCents - ownCreditCents;
    return {
      invoice,
      debitCents,
      ownCreditCents,
      grossRemainingCents: Math.max(0, net),
      creditsApplied: [],
      remainingCents: Math.max(0, net),
      surplusCents: Math.max(0, -net),
      surplusAppliedTo: [],
      unappliedSurplusCents: Math.max(0, -net),
    };
  });

  const applications: CreditApplication[] = [];
  // Crédito mais antigo primeiro, fatura que vence primeiro primeiro.
  const sources = rows.filter((r) => r.surplusCents > 0);
  for (const target of rows) {
    for (const source of sources) {
      if (target.remainingCents === 0) break;
      if (source.unappliedSurplusCents === 0) continue;
      const cents = Math.min(target.remainingCents, source.unappliedSurplusCents);
      const application: CreditApplication = {
        fromInvoiceId: idOf(source.invoice.span),
        fromReferenceMonth: source.invoice.span.referenceMonth,
        toInvoiceId: idOf(target.invoice.span),
        toReferenceMonth: target.invoice.span.referenceMonth,
        cents,
      };
      target.remainingCents -= cents;
      target.creditsApplied.push(application);
      source.unappliedSurplusCents -= cents;
      source.surplusAppliedTo.push(application);
      applications.push(application);
    }
  }

  const sum = (pick: (r: ReconciledInvoice<S>) => number) =>
    rows.reduce((total, r) => total + pick(r), 0);
  return {
    invoices: rows,
    grossDebtCents: sum((r) => r.grossRemainingCents),
    appliedCreditCents: applications.reduce((total, a) => total + a.cents, 0),
    netDebtCents: sum((r) => r.remainingCents),
    unappliedCreditCents: sum((r) => r.unappliedSurplusCents),
    applications,
  };
}

/** Restante conciliado de uma fatura, pela identidade dela. */
export function remainingById<S extends InvoiceSpan & { id?: string }>(
  reconciliation: CardReconciliation<S>,
): Map<string, ReconciledInvoice<S>> {
  return new Map(reconciliation.invoices.map((r) => [idOf(r.invoice.span), r]));
}

/** `true` se a fatura vence antes de `today` (vencida, se ainda tiver restante). */
export function isPastDue(span: InvoiceSpan, today: CalendarDay) {
  return compareCalendarDays(span.dueDate, today) < 0;
}
