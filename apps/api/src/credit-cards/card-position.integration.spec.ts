import { parseDateOnly } from '../common/date.util';
import {
  FinancialEnv,
  createFinancialEnv,
  dayFromToday,
  integration,
  key,
} from '../../test/financial-test-env';

/**
 * Itens 4 e 5 da revisão do modelo pessoal (docs/adrs/0018): previsão não é
 * dívida; créditos entre faturas são aplicados por uma regra explícita, a
 * mesma em todas as telas.
 */
integration('cartão: previsões, obrigações e créditos entre faturas (PostgreSQL)', () => {
  let env: FinancialEnv;
  let userId: string;
  let checking: string;

  beforeAll(async () => {
    env = await createFinancialEnv();
    userId = await env.createUser();
    checking = await env.account(userId, 10000);
  });

  afterAll(async () => {
    if (env) await env.close();
  });

  /** Cartão com fechamento 10, vencimento 17 e controle desde 2026-01-01. */
  async function newCard() {
    const card = await env.cards.create(userId, {
      name: `Cartão ${Math.random().toString(36).slice(2, 6)}`,
      closingDay: 10,
      dueDay: 17,
      creditLimit: 10000,
    });
    await env.prisma.creditCard.update({
      where: { id: card.id },
      data: { invoiceTrackingStart: parseDateOnly('2026-01-01') },
    });
    return card;
  }

  const buy = (accountId: string, amount: number, date: string, extra = {}) =>
    env.transactions.create(userId, {
      accountId,
      type: 'expense',
      amount,
      description: 'Compra',
      transactionDate: date,
      ...extra,
    });

  const pay = (cardId: string, invoiceId: string, amount: number) =>
    env.payments.pay(userId, cardId, invoiceId, {
      sourceAccountId: checking,
      amount,
      paymentDate: dayFromToday(0),
      idempotencyKey: key(),
    });

  const invoiceOf = async (transactionId: string) =>
    (await env.prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })).invoiceId!;

  it('assinatura cancelável de R$ 200 por 12 meses não vira R$ 2.400 de dívida; compra de R$ 2.400 em 12x vira', async () => {
    const card = await newCard();
    const subscription = await buy(card.accountId, 200, dayFromToday(-3), {
      recurrenceType: 'fixo',
      recurrenceMonths: 12,
    });

    let view = await env.cards.findOne(userId, card.id);
    // Só a ocorrência que já foi cobrada é dívida; as outras 11 são previsão.
    expect(view.totalDebt).toBe(200);
    expect(view.forecast).toBe(2200);

    await buy(card.accountId, 2400, dayFromToday(-3), {
      recurrenceType: 'parcelado',
      installments: 12,
    });
    view = await env.cards.findOne(userId, card.id);
    expect(view.totalDebt).toBe(2600);

    // Cancelar as cobranças futuras previstas não apaga o que já foi cobrado.
    await env.recurrences.setActive(userId, subscription.seriesId!, false);
    view = await env.cards.findOne(userId, card.id);
    expect(view).toMatchObject({ totalDebt: 2600, forecast: 0 });
  });

  it('compra futura cadastrada é previsão: não vira dívida nem consome limite', async () => {
    const card = await newCard();
    await buy(card.accountId, 900, dayFromToday(5));
    const view = await env.cards.findOne(userId, card.id);
    expect(view).toMatchObject({ totalDebt: 0, committed: 0, forecast: 900 });
  });

  it('crédito de R$ 100 numa fatura compensa a cobrança de R$ 100 da seguinte em todas as telas', async () => {
    const card = await newCard();
    const old = await buy(card.accountId, 500, '2026-08-20'); // fatura que vence em 17/09
    const oldInvoice = await invoiceOf(old.id);
    const payment = await pay(card.id, oldInvoice, 600);
    const next = await buy(card.accountId, 100, '2026-09-20'); // fatura que vence em 17/10
    const nextInvoice = await invoiceOf(next.id);

    const invoice = await env.cards.invoice(userId, card.id, nextInvoice);
    expect(invoice).toMatchObject({ total: 100, grossRemaining: 100, remaining: 0 });
    expect(invoice.creditsApplied).toEqual([
      expect.objectContaining({ invoiceId: oldInvoice, amount: 100 }),
    ]);
    const origin = await env.cards.invoice(userId, card.id, oldInvoice);
    expect(origin.surplusAppliedTo).toEqual([
      expect.objectContaining({ invoiceId: nextInvoice, amount: 100 }),
    ]);

    expect(await env.cards.findOne(userId, card.id)).toMatchObject({ totalDebt: 0, credit: 0 });
    const dashboard = await env.dashboard.getSummary(userId, undefined, undefined, {
      cardIds: [card.id],
    });
    expect(dashboard.upcomingBills).toEqual([]);
    expect(dashboard.cards).toMatchObject({ totalDebt: 0, creditBalance: 0 });

    // Reverter o pagamento restaura as faturas e desfaz a aplicação do crédito.
    await env.payments.reverse(userId, card.id, oldInvoice, payment.id);
    expect(await env.cards.invoice(userId, card.id, nextInvoice)).toMatchObject({
      remaining: 100,
      creditsApplied: [],
    });
    expect((await env.cards.findOne(userId, card.id)).totalDebt).toBe(600);
  });

  it('pagamento a mais na primeira fatura abate as futuras, que não aparecem como valor a pagar', async () => {
    const card = await newCard();
    const first = await buy(card.accountId, 300, dayFromToday(-3), {
      recurrenceType: 'parcelado',
      installments: 3,
    });
    const last = await env.prisma.transaction.findFirstOrThrow({
      where: { seriesId: first.seriesId, installmentNumber: 3 },
    });
    // Fatura que ainda não começou não recebe pagamento direto (docs/adrs/0021).
    await expect(pay(card.id, last.invoiceId!, 100)).rejects.toMatchObject({ status: 400 });

    // R$ 200 na fatura da 1ª parcela (R$ 100): os R$ 100 a mais abatem as seguintes.
    await pay(card.id, await invoiceOf(first.id), 200);

    const view = await env.cards.findOne(userId, card.id);
    expect(view.futureCharges).toBe(200);
    expect(view.futureInstallments).toBe(100);
    expect(view.totalDebt).toBe(100);
  });

  it('créditos de cartões diferentes não se compensam', async () => {
    const withCredit = await newCard();
    const withDebt = await newCard();
    const a = await buy(withCredit.accountId, 100, '2026-08-20');
    await pay(withCredit.id, await invoiceOf(a.id), 200);
    await buy(withDebt.accountId, 100, '2026-08-20');

    expect(await env.cards.findOne(userId, withCredit.id)).toMatchObject({
      totalDebt: 0,
      credit: 100,
    });
    expect(await env.cards.findOne(userId, withDebt.id)).toMatchObject({
      totalDebt: 100,
      credit: 0,
    });
  });
});
