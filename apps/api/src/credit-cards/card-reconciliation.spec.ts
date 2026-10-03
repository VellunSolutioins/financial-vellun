import { CalendarDay } from '../common/date.util';
import { reconcileCard } from './card-reconciliation';
import { InvoiceAmounts, InvoiceSpan, cardPosition, configCycleFor } from './invoice-cycle';

/** Critérios do item 5 da revisão do modelo pessoal (docs/adrs/0018). */

const d = (iso: string): CalendarDay => {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, monthIndex: month - 1, day };
};
const config = { closingDay: 5, dueDay: 12 };
const span = (iso: string, id: string): InvoiceSpan & { id: string } => ({
  ...configCycleFor(d(iso), config),
  id,
});
const invoice = (
  s: InvoiceSpan & { id: string },
  charges: number,
  extra: Partial<InvoiceAmounts> = {},
): InvoiceAmounts<InvoiceSpan & { id: string }> => ({
  span: s,
  chargesCents: charges,
  refundsCents: 0,
  paymentsCents: 0,
  ...extra,
});

const sep = span('2026-08-20', 'sep'); // fecha 05/09, vence 12/09
const oct = span('2026-09-20', 'oct'); // fecha 05/10, vence 12/10
const nov = span('2026-10-20', 'nov'); // fecha 05/11, vence 12/11

describe('reconcileCard', () => {
  it('crédito de R$ 100 numa fatura compensa a cobrança de R$ 100 da seguinte', () => {
    const result = reconcileCard([
      invoice(sep, 50000, { paymentsCents: 60000 }), // pagou 100 a mais
      invoice(oct, 10000),
    ]);

    const [first, second] = result.invoices;
    expect(first.surplusCents).toBe(10000);
    expect(second.grossRemainingCents).toBe(10000);
    expect(second.remainingCents).toBe(0);
    expect(second.creditsApplied).toEqual([
      expect.objectContaining({ fromInvoiceId: 'sep', toInvoiceId: 'oct', cents: 10000 }),
    ]);
    expect(first.surplusAppliedTo).toEqual(second.creditsApplied);
    expect(result).toMatchObject({
      grossDebtCents: 10000,
      appliedCreditCents: 10000,
      netDebtCents: 0,
      unappliedCreditCents: 0,
    });
  });

  it('crédito sem cobrança onde aplicar fica separado: bruto, crédito e líquido', () => {
    const result = reconcileCard([invoice(sep, 10000, { paymentsCents: 12500 })]);

    expect(result).toMatchObject({
      grossDebtCents: 0,
      appliedCreditCents: 0,
      netDebtCents: 0,
      unappliedCreditCents: 2500,
    });
  });

  it('aplica o crédito mais antigo primeiro, na fatura que vence primeiro', () => {
    const result = reconcileCard([
      invoice(nov, 10000),
      invoice(sep, 0, { paymentsCents: 3000 }),
      invoice(oct, 5000, { refundsCents: 9000 }),
    ]);

    expect(result.applications.map((a) => [a.fromInvoiceId, a.toInvoiceId, a.cents])).toEqual([
      ['sep', 'nov', 3000],
      ['oct', 'nov', 4000],
    ]);
    expect(result.netDebtCents).toBe(3000);
  });

  it('a dívida líquida sempre bate com a soma das faturas', () => {
    const invoices = [
      invoice(sep, 33333, { paymentsCents: 40000 }),
      invoice(oct, 12345, { refundsCents: 345 }),
      invoice(nov, 777, { paymentsCents: 100 }),
    ];
    const result = reconcileCard(invoices);
    const net = invoices.reduce(
      (sum, i) => sum + i.chargesCents - i.refundsCents - i.paymentsCents,
      0,
    );
    expect(result.netDebtCents - result.unappliedCreditCents).toBe(net);
  });

  it('a posição inicial entra como débito e crédito da fatura anterior ao controle', () => {
    const result = reconcileCard([
      invoice(sep, 0, { openingDebtCents: 80000 }),
      invoice(oct, 0, { openingCreditCents: 5000 }),
    ]);
    expect(result.netDebtCents).toBe(75000);
  });
});

describe('cardPosition conciliada', () => {
  const today = d('2026-09-20'); // fatura aberta: a que fecha em 05/10

  it('fatura futura totalmente paga não aparece como valor a pagar', () => {
    const position = cardPosition(
      [invoice(oct, 10000), invoice(nov, 40000, { paymentsCents: 40000 })],
      config,
      today,
    );
    expect(position.futureChargesCents).toBe(40000);
    expect(position.futureRemainingCents).toBe(0);
    expect(position.totalDebtCents).toBe(10000);
  });

  it('previsão (assinatura futura) não é dívida', () => {
    const position = cardPosition(
      [invoice(oct, 20000, { forecastCents: 0 }), invoice(nov, 0, { forecastCents: 20000 })],
      config,
      today,
    );
    expect(position.totalDebtCents).toBe(20000);
    expect(position.forecastCents).toBe(20000);
  });

  it('o restante da fatura atual já considera o crédito da anterior', () => {
    const position = cardPosition(
      [invoice(sep, 50000, { paymentsCents: 60000 }), invoice(oct, 10000)],
      config,
      today,
    );
    expect(position.currentTotalCents).toBe(10000);
    expect(position.currentRemainingCents).toBe(0);
    expect(position.totalDebtCents).toBe(0);
    expect(position.creditCents).toBe(0);
  });

  it('vencida: fechada, com vencimento passado e restante', () => {
    const position = cardPosition([invoice(sep, 30000, { paymentsCents: 10000 })], config, today);
    expect(position.closedUnpaidCents).toBe(20000);
    expect(position.overdueCents).toBe(20000);
  });
});
