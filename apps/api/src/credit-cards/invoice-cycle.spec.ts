import { CalendarDay } from '../common/date.util';
import {
  InvoiceSpan,
  cardPosition,
  configCycleFor,
  cycleFor,
  cycleState,
  dueDateAfter,
  paymentStatus,
} from './invoice-cycle';

/** `'2026-02-28'` → dia-calendário. */
function d(iso: string): CalendarDay {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, monthIndex: month - 1, day };
}

function iso(day: CalendarDay): string {
  return `${day.year}-${String(day.monthIndex + 1).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
}

function show(span: InvoiceSpan) {
  return {
    ref: span.referenceMonth,
    start: iso(span.periodStart),
    closing: iso(span.closingDate),
    due: iso(span.dueDate),
  };
}

describe('ciclo da fatura', () => {
  it.each([
    // fechamento, compra, fechamento esperado
    [28, '2026-02-10', '2026-02-28'],
    [30, '2026-02-10', '2026-02-28'],
    [31, '2026-02-10', '2026-02-28'],
    [31, '2028-02-10', '2028-02-29'], // bissexto
    [30, '2026-04-10', '2026-04-30'],
    [31, '2026-04-10', '2026-04-30'],
    [31, '2026-03-10', '2026-03-31'],
  ])('fechamento dia %i: compra em %s fecha em %s', (closingDay, purchase, closing) => {
    const span = configCycleFor(d(purchase), { closingDay, dueDay: 10 });
    expect(iso(span.closingDate)).toBe(closing);
  });

  it('período vai do fechamento anterior à véspera do fechamento, mesmo com clamp', () => {
    // Fechamento 31: jan/31 → fev/28 → mar/31.
    expect(show(configCycleFor(d('2026-02-15'), { closingDay: 31, dueDay: 10 }))).toEqual({
      ref: '2026-03',
      start: '2026-01-31',
      closing: '2026-02-28',
      due: '2026-03-10',
    });
    expect(show(configCycleFor(d('2026-03-01'), { closingDay: 31, dueDay: 10 }))).toEqual({
      ref: '2026-04',
      start: '2026-02-28',
      closing: '2026-03-31',
      due: '2026-04-10',
    });
  });

  it('compra no dia do fechamento vai para a próxima fatura', () => {
    const config = { closingDay: 5, dueDay: 12 };
    expect(show(configCycleFor(d('2026-03-04'), config)).closing).toBe('2026-03-05');
    expect(show(configCycleFor(d('2026-03-05'), config)).closing).toBe('2026-04-05');
    // Clamp: fechamento 30 em fevereiro é dia 28; comprar no dia 28 já é o próximo ciclo.
    expect(show(configCycleFor(d('2026-02-28'), { closingDay: 30, dueDay: 8 })).closing).toBe(
      '2026-03-30',
    );
  });

  it('vencimento é o primeiro dia de vencimento depois do fechamento', () => {
    // Vencimento depois do fechamento no mesmo mês.
    expect(iso(dueDateAfter(d('2026-03-05'), 12))).toBe('2026-03-12');
    // Vencimento "antes" do fechamento: cai no mês seguinte.
    expect(iso(dueDateAfter(d('2026-03-25'), 5))).toBe('2026-04-05');
    // Mesmo dia do fechamento não vale: é o mês seguinte.
    expect(iso(dueDateAfter(d('2026-03-10'), 10))).toBe('2026-04-10');
    // Clamp no vencimento.
    expect(iso(dueDateAfter(d('2026-01-31'), 30))).toBe('2026-02-28');
  });

  it('referenceMonth é o mês do vencimento', () => {
    expect(configCycleFor(d('2026-03-26'), { closingDay: 25, dueDay: 2 }).referenceMonth).toBe(
      '2026-05',
    );
    expect(configCycleFor(d('2026-03-20'), { closingDay: 25, dueDay: 2 }).referenceMonth).toBe(
      '2026-04',
    );
  });

  it('estado do ciclo e situação de pagamento', () => {
    const span = configCycleFor(d('2026-03-10'), { closingDay: 20, dueDay: 28 });
    expect(cycleState(span, d('2026-03-19'))).toBe('open');
    expect(cycleState(span, d('2026-03-20'))).toBe('closed');
    expect(paymentStatus(10000, 0)).toBe('unpaid');
    expect(paymentStatus(10000, 4000)).toBe('partial');
    expect(paymentStatus(10000, 10000)).toBe('paid');
    expect(paymentStatus(10000, 12000)).toBe('credit');
  });
});

describe('cycleFor com faturas gravadas', () => {
  const old = { closingDay: 5, dueDay: 30 };

  it('faturas gravadas mantêm as datas depois de uma troca de configuração', () => {
    const closed = configCycleFor(d('2026-03-01'), old); // fev/05 → mar/05, vence mar/30
    const current = configCycleFor(d('2026-03-10'), old); // mar/05 → abr/05, vence abr/30
    const existing = [closed, current];
    const novo = { closingDay: 20, dueDay: 28 };

    expect(cycleFor(d('2026-03-01'), novo, existing).span).toBe(closed);
    expect(cycleFor(d('2026-04-04'), novo, existing).span).toBe(current);

    // Depois da atual, vale a configuração nova, começando no fechamento gravado.
    // O ciclo abr/05 → abr/20 venceria abr/28, no mesmo mês da atual (abr/30):
    // é absorvido pelo seguinte.
    const next = cycleFor(d('2026-04-06'), novo, existing);
    expect(next.isNew).toBe(true);
    expect(show(next.span as InvoiceSpan)).toEqual({
      ref: '2026-05',
      start: '2026-04-05',
      closing: '2026-05-20',
      due: '2026-05-28',
    });
    // E o ciclo depois dele já segue a configuração nova sem ajuste.
    const after = cycleFor(d('2026-05-21'), novo, [...existing, next.span as InvoiceSpan]);
    expect(show(after.span as InvoiceSpan)).toEqual({
      ref: '2026-06',
      start: '2026-05-20',
      closing: '2026-06-20',
      due: '2026-06-28',
    });
  });

  it('ciclo de transição com o mesmo vencimento é absorvido pelo seguinte', () => {
    // Atual: fecha mar/25, vence abr/02 (ref 2026-04).
    const current = configCycleFor(d('2026-03-10'), { closingDay: 25, dueDay: 2 });
    expect(current.referenceMonth).toBe('2026-04');
    // Nova config: fecha dia 5, vence dia 30. O ciclo mar/25 → abr/05 venceria
    // abr/30 (ref 2026-04 de novo): vira mar/25 → mai/05, vence mai/30.
    const next = cycleFor(d('2026-03-26'), { closingDay: 5, dueDay: 30 }, [current]);
    expect(show(next.span as InvoiceSpan)).toEqual({
      ref: '2026-05',
      start: '2026-03-25',
      closing: '2026-05-05',
      due: '2026-05-30',
    });
  });

  it('compra retroativa antes de uma fatura gravada não a sobrepõe', () => {
    const later = configCycleFor(d('2026-05-10'), { closingDay: 20, dueDay: 28 }); // abr/20 → mai/20
    const earlier = cycleFor(d('2026-04-02'), { closingDay: 20, dueDay: 28 }, [later]);
    expect(show(earlier.span as InvoiceSpan)).toEqual({
      ref: '2026-04',
      start: '2026-03-20',
      closing: '2026-04-20',
      due: '2026-04-28',
    });
  });
});

describe('posição do cartão', () => {
  const config = { closingDay: 5, dueDay: 12 };
  const today = d('2026-03-10');
  const closed = configCycleFor(d('2026-03-01'), config); // fecha mar/05
  const current = configCycleFor(d('2026-03-10'), config); // fecha abr/05
  const future1 = configCycleFor(d('2026-04-10'), config);
  const future2 = configCycleFor(d('2026-05-10'), config);
  const amounts = (span: InvoiceSpan, charges: number, payments = 0) => ({
    span,
    chargesCents: charges,
    refundsCents: 0,
    paymentsCents: payments,
  });

  it('separa fatura atual, parcelas futuras, fechadas em aberto e dívida total', () => {
    const position = cardPosition(
      [
        amounts(closed, 20000, 5000),
        amounts(current, 10000),
        amounts(future1, 10000),
        amounts(future2, 10001),
      ],
      config,
      today,
    );
    expect(position.current.referenceMonth).toBe(current.referenceMonth);
    expect(position.currentTotalCents).toBe(10000);
    expect(position.futureInstallmentsCents).toBe(20001);
    expect(position.closedUnpaidCents).toBe(15000);
    expect(position.totalDebtCents).toBe(20000 - 5000 + 10000 + 10000 + 10001);
    expect(position.creditCents).toBe(0);
  });

  it('sem fatura gravada hoje, a atual é a calculada e vale zero', () => {
    const position = cardPosition([amounts(future1, 3000)], config, today);
    expect(iso(position.current.closingDate)).toBe('2026-04-05');
    expect(position.currentTotalCents).toBe(0);
    expect(position.futureInstallmentsCents).toBe(3000);
  });

  it('pago acima do cobrado vira crédito, não dívida negativa', () => {
    const position = cardPosition([amounts(closed, 10000, 12500)], config, today);
    expect(position.totalDebtCents).toBe(0);
    expect(position.creditCents).toBe(2500);
  });
});
