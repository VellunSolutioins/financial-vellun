import {
  FinancialEnv,
  createFinancialEnv,
  dayFromToday,
  integration,
  key,
} from '../../test/financial-test-env';

/**
 * Item 7 da revisão do modelo pessoal (docs/adrs/0018): movimentações que não
 * são receita nem despesa.
 */
integration('transferências, empréstimos e investimentos (PostgreSQL)', () => {
  let env: FinancialEnv;
  let userId: string;
  let otherId: string;

  beforeAll(async () => {
    env = await createFinancialEnv();
    userId = await env.createUser();
    otherId = await env.createUser();
  });

  afterAll(async () => {
    if (env) await env.close();
  });

  const summary = () => env.dashboard.getSummary(userId);
  const transfer = (fromAccountId: string, toAccountId: string, amount: number, extra = {}) =>
    env.transfers.create(userId, {
      fromAccountId,
      toAccountId,
      amount,
      date: dayFromToday(0),
      idempotencyKey: key(),
      ...extra,
    });

  it('transferir R$ 500 entre contas próprias muda os saldos individuais, não receita, gasto ou soma', async () => {
    const a = await env.account(userId, 1000);
    const b = await env.account(userId, 200);
    const before = await summary();

    const k = key();
    const created = await transfer(a, b, 500, { idempotencyKey: k });
    expect(created.kind).toBe('own_transfer');
    await expect(transfer(a, b, 500, { idempotencyKey: k })).resolves.toMatchObject({
      id: created.id,
      idempotent: true,
    });

    expect([await env.balance(a), await env.balance(b)]).toEqual([500, 700]);
    const after = await summary();
    expect(after.cashBalance).toBe(before.cashBalance);
    expect(after.income.received).toBe(before.income.received);
    expect(after.spending.realized).toBe(before.spending.realized);

    // Reverter restaura os saldos; o histórico fica.
    await env.transfers.reverse(userId, created.id);
    await env.transfers.reverse(userId, created.id);
    expect([await env.balance(a), await env.balance(b)]).toEqual([1000, 200]);
  });

  it('empréstimo: receber aumenta caixa e dívida sem receita; amortizar reduz os dois sem despesa; juros à parte', async () => {
    const checking = await env.account(userId, 0);
    const loan = await env.account(userId, 0, 'loan');
    const before = await summary();

    const received = await transfer(loan, checking, 10000);
    expect(received.kind).toBe('loan_received');
    let after = await summary();
    expect(after.cashBalance).toBe(before.cashBalance! + 10000);
    expect(after.loansDebt).toBe(before.loansDebt + 10000);
    expect(after.income.received).toBe(before.income.received);

    const payment = await transfer(checking, loan, 1000, { feeAmount: 150 });
    expect(payment).toMatchObject({ kind: 'loan_payment', fee: { amount: 150 } });
    expect(await env.balance(checking)).toBe(8850);
    after = await summary();
    expect(after.loansDebt).toBe(before.loansDebt + 9000);
    // O principal não é despesa; os juros são, e com classificação própria.
    expect(after.spending.realized).toBe(before.spending.realized + 150);
    expect(after.spending.byNature.financial_cost).toBe(
      before.spending.byNature.financial_cost + 150,
    );
  });

  it('aporte e resgate não são confundidos com rendimento', async () => {
    const checking = await env.account(userId, 3000);
    const investment = await env.account(userId, 0, 'investment');
    const before = await summary();

    expect((await transfer(checking, investment, 2000)).kind).toBe('investment_contribution');
    expect((await transfer(investment, checking, 500)).kind).toBe('investment_withdrawal');
    let after = await summary();
    expect(after.cashBalance).toBe(before.cashBalance! - 1500);
    expect(after.investmentsBalance).toBe(before.investmentsBalance + 1500);
    expect(after.income.received).toBe(before.income.received);
    expect(after.spending.realized).toBe(before.spending.realized);

    // Rendimento é receita da conta de investimento.
    await env.transactions.create(userId, {
      accountId: investment,
      type: 'income',
      amount: 30,
      description: 'Rendimento',
      transactionDate: dayFromToday(0),
    });
    after = await summary();
    expect(after.income.received).toBe(before.income.received + 30);
    expect(after.investmentsBalance).toBe(before.investmentsBalance + 1530);
  });

  it('recusa cartão, conta de outro usuário e data futura', async () => {
    const mine = await env.account(userId, 100);
    const theirs = await env.account(otherId, 100);
    const card = await env.cards.create(userId, { name: 'Cartão', closingDay: 5, dueDay: 12 });

    await expect(transfer(mine, theirs, 10)).rejects.toMatchObject({ status: 400 });
    await expect(transfer(mine, card.accountId, 10)).rejects.toMatchObject({ status: 400 });
    await expect(
      transfer(mine, await env.account(userId, 0), 10, { date: dayFromToday(2) }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await env.balance(theirs)).toBe(100);
  });
});
