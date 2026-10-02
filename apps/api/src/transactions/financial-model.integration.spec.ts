import {
  FinancialEnv,
  createFinancialEnv,
  dayFromToday,
  integration,
  key,
} from '../../test/financial-test-env';

/**
 * Item 2 da revisão do modelo pessoal (docs/adrs/0018): vencimento não é
 * pagamento. O saldo só muda com liquidação; a passagem do tempo torna uma
 * obrigação vencida, nunca a liquida.
 */
integration('vencimento × pagamento (PostgreSQL)', () => {
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

  const expense = (accountId: string, amount: number, date: string, extra = {}) =>
    env.transactions.create(userId, {
      accountId,
      type: 'expense',
      amount,
      description: 'Aluguel',
      transactionDate: date,
      ...extra,
    });

  it('R$ 5.000 com aluguel de R$ 600: nada sai até o pagamento; R$ 200 pagos deixam R$ 4.800 e R$ 400 em aberto', async () => {
    const accountId = await env.account(userId, 5000);

    // Previsto para amanhã: não mexe no saldo.
    const tomorrow = await expense(accountId, 600, dayFromToday(1));
    expect(tomorrow).toMatchObject({ state: 'open', remaining: 600, isOverdue: false });
    expect(await env.balance(accountId)).toBe(5000);

    // A data chegou (aqui, já passou) e o scheduler rodou: continua R$ 5.000.
    const rent = await expense(accountId, 600, dayFromToday(-1), { settle: false });
    await env.scheduler.verifyBalances();
    expect(await env.balance(accountId)).toBe(5000);
    expect(
      await env.prisma.transactionSettlement.count({ where: { transactionId: rent.id } }),
    ).toBe(0);

    // Vencida e não paga continua consultável, com o valor restante.
    const overdue = await env.transactions.findAll(userId, { settlement: 'overdue' });
    expect(overdue.data.map((t) => [t.id, t.remaining, t.isOverdue])).toEqual([
      [rent.id, 600, true],
    ]);

    // Pagamento parcial de R$ 200.
    const k = key();
    const first = await env.settlements.settle(userId, rent.id, {
      amount: 200,
      date: dayFromToday(0),
      idempotencyKey: k,
    });
    expect(await env.balance(accountId)).toBe(4800);
    expect(await env.transactions.findOne(userId, rent.id)).toMatchObject({
      state: 'partial',
      remaining: 400,
      isOverdue: true,
    });

    // Repetir a mesma chave não paga de novo.
    await expect(
      env.settlements.settle(userId, rent.id, {
        amount: 200,
        date: dayFromToday(0),
        idempotencyKey: k,
      }),
    ).resolves.toMatchObject({ id: first.id, idempotent: true });
    expect(await env.balance(accountId)).toBe(4800);

    // Acima do que falta: recusado.
    await expect(
      env.settlements.settle(userId, rent.id, {
        amount: 400.01,
        date: dayFromToday(0),
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    // Pagamento com data futura: recusado.
    await expect(
      env.settlements.settle(userId, rent.id, { date: dayFromToday(3), idempotencyKey: key() }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('dois pagamentos simultâneos não passam do restante', async () => {
    const accountId = await env.account(userId, 1000);
    const bill = await expense(accountId, 400, dayFromToday(-2), { settle: false });

    const results = await Promise.allSettled(
      [300, 300].map((amount) =>
        env.settlements.settle(userId, bill.id, {
          amount,
          date: dayFromToday(0),
          idempotencyKey: key(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const stored = await env.prisma.transaction.findUniqueOrThrow({ where: { id: bill.id } });
    expect(Number(stored.settledAmount)).toBe(300);
    expect(await env.balance(accountId)).toBe(700);
  });

  it('reverter devolve o valor ao restante e ao saldo; dispensar fecha sem mexer no saldo', async () => {
    const accountId = await env.account(userId, 1000);
    const bill = await expense(accountId, 300, dayFromToday(-5), { settle: false });
    const paid = await env.settlements.settle(userId, bill.id, {
      amount: 100,
      date: dayFromToday(0),
      idempotencyKey: key(),
    });
    expect(await env.balance(accountId)).toBe(900);

    await env.settlements.reverse(userId, bill.id, paid.id);
    await env.settlements.reverse(userId, bill.id, paid.id); // idempotente
    expect(await env.balance(accountId)).toBe(1000);
    expect(await env.transactions.findOne(userId, bill.id)).toMatchObject({
      state: 'open',
      remaining: 300,
    });
    // O histórico fica.
    expect((await env.settlements.list(userId, bill.id)).map((s) => s.status)).toEqual([
      'reversed',
    ]);

    await env.settlements.settle(userId, bill.id, {
      kind: 'write_off',
      date: dayFromToday(0),
      idempotencyKey: key(),
    });
    expect(await env.balance(accountId)).toBe(1000);
    expect(await env.transactions.findOne(userId, bill.id)).toMatchObject({
      state: 'settled',
      remaining: 0,
      isOverdue: false,
    });
  });

  it('receita prevista não aumenta o saldo até ser recebida', async () => {
    const accountId = await env.account(userId, 100);
    await env.transactions.create(userId, {
      accountId,
      type: 'income',
      amount: 1000,
      description: 'Salário',
      transactionDate: dayFromToday(5),
    });
    const late = await env.transactions.create(userId, {
      accountId,
      type: 'income',
      amount: 500,
      description: 'Freela',
      transactionDate: dayFromToday(-1),
      settle: false,
    });
    expect(await env.balance(accountId)).toBe(100);

    await env.settlements.settle(userId, late.id, { date: dayFromToday(0), idempotencyKey: key() });
    expect(await env.balance(accountId)).toBe(600);
  });

  it('lançamento à vista cria o gasto e o pagamento na mesma operação', async () => {
    const accountId = await env.account(userId, 100);
    const lunch = await expense(accountId, 35.5, dayFromToday(0));

    expect(lunch).toMatchObject({ state: 'settled', remaining: 0 });
    expect(await env.balance(accountId)).toBe(64.5);
    const [settlement] = await env.settlements.list(userId, lunch.id);
    expect(settlement).toMatchObject({ amount: 35.5, origin: 'at_sight', kind: 'payment' });
  });

  it('com pagamento registrado, não exclui nem cancela; revertido, exclui', async () => {
    const accountId = await env.account(userId, 100);
    const bill = await expense(accountId, 50, dayFromToday(0));

    await expect(env.transactions.remove(userId, bill.id)).rejects.toMatchObject({ status: 409 });
    await expect(
      env.transactions.update(userId, bill.id, { status: 'cancelled' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(env.transactions.update(userId, bill.id, { amount: 40 })).rejects.toMatchObject({
      status: 409,
    });

    const [settlement] = await env.settlements.list(userId, bill.id);
    await env.settlements.reverse(userId, bill.id, settlement.id);
    await env.transactions.remove(userId, bill.id);
    expect(await env.balance(accountId)).toBe(100);
  });

  it('recorrência: previsão vencida segue visível; pausar não apaga o que foi pago', async () => {
    const accountId = await env.account(userId, 1000);
    const first = await env.transactions.create(userId, {
      accountId,
      type: 'expense',
      amount: 50,
      description: 'Academia',
      transactionDate: dayFromToday(-20),
      recurrenceType: 'fixo',
      recurrenceMonths: 3,
    });
    // Recorrência nasce como previsão, não como obrigação nem pagamento.
    expect(first).toMatchObject({ state: 'forecast', forecast: true, isOverdue: true });
    expect(await env.balance(accountId)).toBe(1000);

    await env.settlements.settle(userId, first.id, {
      date: dayFromToday(0),
      idempotencyKey: key(),
    });
    expect(await env.balance(accountId)).toBe(950);
    expect(await env.transactions.findOne(userId, first.id)).toMatchObject({
      state: 'settled',
      forecast: false,
    });

    await env.recurrences.setActive(userId, first.seriesId!, false);
    const series = await env.prisma.transaction.findMany({
      where: { seriesId: first.seriesId },
      orderBy: { transactionDate: 'asc' },
    });
    expect(series.map((t) => t.status)).toEqual(['confirmed', 'cancelled', 'cancelled']);
    expect(await env.balance(accountId)).toBe(950);
  });

  it('isolamento: outro usuário não paga nem vê o lançamento', async () => {
    const accountId = await env.account(userId, 100);
    const bill = await expense(accountId, 10, dayFromToday(-1), { settle: false });

    await expect(
      env.settlements.settle(otherId, bill.id, { date: dayFromToday(0), idempotencyKey: key() }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(env.settlements.list(otherId, bill.id)).rejects.toMatchObject({ status: 404 });
    expect(await env.balance(accountId)).toBe(100);
  });

  it('PJ (compatibilidade): a pagar lista o que está em aberto, inclusive vencido', async () => {
    const businessId = await env.createUser('business');
    const accountId = await env.account(businessId, 0);
    await env.transactions.create(businessId, {
      accountId,
      type: 'expense',
      amount: 120,
      description: 'Fornecedor',
      transactionDate: dayFromToday(-3),
      settle: false,
    });
    const summary = await env.dashboard.getBusinessSummary(businessId);
    expect(summary.accountsPayable).toMatchObject({ total: 120, count: 1 });
  });
});
