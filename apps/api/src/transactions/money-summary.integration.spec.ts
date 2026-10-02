import { parseDateOnly } from '../common/date.util';
import {
  FinancialEnv,
  createFinancialEnv,
  dayFromToday,
  integration,
  key,
} from '../../test/financial-test-env';

/**
 * Blocos de Lançamentos em linguagem comum (docs/adrs/0020): "Recebido" e
 * "Pago" são dinheiro que entrou e saiu; compra no cartão fica "no cartão" até
 * a fatura ser paga. Reverter muda o número na hora.
 */
integration('resumo de Lançamentos: recebido, pago e no cartão (PostgreSQL)', () => {
  let env: FinancialEnv;
  let userId: string;
  const today = dayFromToday(0);
  const period = { periodStart: `${today.slice(0, 7)}-01`, periodEnd: today };

  beforeAll(async () => {
    env = await createFinancialEnv();
    userId = await env.createUser();
  });

  afterAll(async () => {
    if (env) await env.close();
  });

  const summary = () => env.transactions.summary(userId, period);
  const money = async () => {
    const s = await summary();
    return {
      received: s.received,
      toReceive: s.toReceive,
      paid: s.paid,
      toPay: s.toPay,
      onCard: s.onCard,
      leftover: s.leftover,
    };
  };

  it('reverter recebimento, compra no cartão e pagamento da fatura mexem nos blocos certos', async () => {
    const checking = await env.account(userId, 0);
    const savings = await env.account(userId, 0);

    const salary = await env.transactions.create(userId, {
      accountId: checking,
      type: 'income',
      amount: 5000,
      description: 'Salário',
      transactionDate: today,
    });
    const extra = await env.transactions.create(userId, {
      accountId: checking,
      type: 'income',
      amount: 100,
      description: 'Extra',
      transactionDate: today,
    });
    expect(salary).toMatchObject({ state: 'settled' });
    expect(extra).toMatchObject({ state: 'settled' });

    await env.transactions.create(userId, {
      accountId: checking,
      type: 'expense',
      amount: 300,
      description: 'Mercado',
      transactionDate: today,
    });
    await env.transactions.create(userId, {
      accountId: checking,
      type: 'expense',
      amount: 200,
      description: 'Luz',
      transactionDate: today,
      settle: false,
    });

    expect(await money()).toEqual({
      received: 5100,
      toReceive: 0,
      paid: 300,
      toPay: 200,
      onCard: 0,
      leftover: 4800,
    });

    // Reverter o recebimento de R$ 100: sai de "Recebido", vai para "A receber".
    const settlement = await env.prisma.transactionSettlement.findFirstOrThrow({
      where: { transactionId: extra.id },
    });
    await env.settlements.reverse(userId, extra.id, settlement.id);
    expect(await money()).toMatchObject({ received: 5000, toReceive: 100, leftover: 4700 });
    // O lançado continua igual: os gráficos seguem lendo `income`.
    expect((await summary()).income).toBe(5100);

    // Compra no cartão: "no cartão", nunca "Pago".
    const card = await env.cards.create(userId, {
      name: 'Cartão resumo',
      closingDay: 28,
      dueDay: 5,
      creditLimit: 5000,
    });
    await env.prisma.creditCard.update({
      where: { id: card.id },
      data: { invoiceTrackingStart: parseDateOnly('2026-01-01') },
    });
    const purchase = await env.transactions.create(userId, {
      accountId: card.accountId,
      type: 'expense',
      amount: 120,
      description: 'Livro',
      transactionDate: today,
    });
    expect(await money()).toMatchObject({ paid: 300, onCard: 120 });

    // Pagar a fatura: o dinheiro sai da conta e entra em "Pago" neste mês.
    const { invoiceId } = await env.prisma.transaction.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    const payment = await env.payments.pay(userId, card.id, invoiceId!, {
      sourceAccountId: checking,
      amount: 120,
      paymentDate: today,
      idempotencyKey: key(),
    });
    expect(await money()).toMatchObject({ paid: 420, onCard: 120, leftover: 4580 });

    // Transferência entre contas próprias não é gasto.
    await env.transfers.create(userId, {
      fromAccountId: checking,
      toAccountId: savings,
      amount: 50,
      date: today,
      idempotencyKey: key(),
    });
    expect(await money()).toMatchObject({ paid: 420 });

    // Desfazer o pagamento da fatura: sai de "Pago" na hora.
    await env.payments.reverse(userId, card.id, invoiceId!, payment.id);
    expect(await money()).toEqual({
      received: 5000,
      toReceive: 100,
      paid: 300,
      toPay: 200,
      onCard: 120,
      leftover: 4700,
    });
  });
});
