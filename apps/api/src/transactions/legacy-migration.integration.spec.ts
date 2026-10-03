import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

import { parseDateOnly } from '../common/date.util';
import {
  FinancialEnv,
  createFinancialEnv,
  dayFromToday,
  integration,
} from '../../test/financial-test-env';

/**
 * Migração do modelo financeiro (docs/adrs/0018) sobre dados no formato
 * antigo. Os comandos de backfill são lidos do próprio arquivo da migração
 * (entre `@backfill-start` e `@backfill-end`) e executados com a tabela de
 * escopo restrita ao usuário deste teste: o SQL testado é o que vai para
 * produção, e nenhum dado de outro teste é tocado.
 */
const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20261002120100_financial_model_tables/migration.sql',
);

function backfillStatements(): string[] {
  const sql = readFileSync(MIGRATION, 'utf-8');
  const body = sql.slice(sql.indexOf('-- @backfill-start'), sql.indexOf('-- @backfill-end'));
  return body
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
}

integration('migração do modelo financeiro sobre dados legados (PostgreSQL)', () => {
  let env: FinancialEnv;
  let userId: string;
  let checking: string;

  beforeAll(async () => {
    env = await createFinancialEnv();
    userId = await env.createUser();
  });

  afterAll(async () => {
    if (env) await env.close();
  });

  async function runBackfill() {
    await env.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `CREATE TEMP TABLE "fm_backfill_users" ON COMMIT DROP AS SELECT "id" FROM "users" WHERE "id" = $1`,
        userId,
      );
      for (const statement of backfillStatements()) await tx.$executeRawUnsafe(statement);
    });
  }

  /** Lançamento como a versão antiga gravava: sem liquidação, fato = data, sem compra. */
  async function legacy(data: {
    accountId: string;
    type: 'income' | 'expense' | 'refund';
    amount: number;
    date: string;
    createdDaysAgo: number;
    status?: 'confirmed' | 'cancelled';
    extra?: Partial<Prisma.TransactionUncheckedCreateInput>;
  }) {
    const date = parseDateOnly(data.date);
    return env.prisma.transaction.create({
      data: {
        userId,
        accountId: data.accountId,
        type: data.type,
        amount: data.amount,
        description: `Legado ${data.type}`,
        transactionDate: date,
        eventDate: date,
        status: data.status ?? 'confirmed',
        createdAt: parseDateOnly(dayFromToday(-data.createdDaysAgo)),
        ...data.extra,
      },
    });
  }

  /** O saldo pela regra antiga: confirmados com data até hoje, conta comum. */
  async function oldRuleBalance(accountId: string) {
    const [row] = await env.prisma.$queryRaw<{ total: string | null }[]>`
      SELECT SUM(CASE WHEN "type" = 'expense' THEN -"amount" ELSE "amount" END)::text AS total
        FROM "transactions"
       WHERE "account_id" = ${accountId} AND "status" = 'confirmed'
         AND "type" IN ('income', 'expense', 'refund')
         AND "transaction_date" <= (now() AT TIME ZONE 'America/Sao_Paulo')::date`;
    const account = await env.prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    return Number(account.initialBalance) + Number(row.total ?? 0);
  }

  it('preserva o saldo, separa registrado de inferido e não duplica ao rodar de novo', async () => {
    checking = await env.account(userId, 1000);
    const card = await env.cards.create(userId, { name: 'Cartão', closingDay: 10, dueDay: 17 });

    const recorded = await legacy({
      accountId: checking,
      type: 'expense',
      amount: 100,
      date: dayFromToday(-10),
      createdDaysAgo: 5,
    });
    const matured = await legacy({
      accountId: checking,
      type: 'expense',
      amount: 200,
      date: dayFromToday(-3),
      createdDaysAgo: 40,
    });
    const salarySeries = randomUUID();
    await legacy({
      accountId: checking,
      type: 'income',
      amount: 1000,
      date: dayFromToday(-2),
      createdDaysAgo: 60,
      extra: { recurrenceType: 'fixo', seriesId: salarySeries, installmentNumber: 1 },
    });
    const futureSalary = await legacy({
      accountId: checking,
      type: 'income',
      amount: 1000,
      date: dayFromToday(28),
      createdDaysAgo: 60,
      extra: { recurrenceType: 'fixo', seriesId: salarySeries, installmentNumber: 2 },
    });
    const futureBill = await legacy({
      accountId: checking,
      type: 'expense',
      amount: 50,
      date: dayFromToday(5),
      createdDaysAgo: 1,
    });
    await legacy({
      accountId: checking,
      type: 'refund',
      amount: 30,
      date: dayFromToday(-1),
      createdDaysAgo: 1,
      extra: { refundOfId: recorded.id },
    });
    await legacy({
      accountId: checking,
      type: 'expense',
      amount: 70,
      date: dayFromToday(-4),
      createdDaysAgo: 4,
      status: 'cancelled',
    });
    const cardPurchase = await legacy({
      accountId: card.accountId,
      type: 'expense',
      amount: 40,
      date: dayFromToday(-2),
      createdDaysAgo: 2,
    });
    const purchaseSeries = randomUUID();
    for (const [n, days] of [
      [1, -40],
      [2, -10],
      [3, 20],
    ]) {
      await legacy({
        accountId: checking,
        type: 'expense',
        amount: 100,
        date: dayFromToday(days),
        createdDaysAgo: 41,
        extra: {
          recurrenceType: 'parcelado',
          seriesId: purchaseSeries,
          installmentNumber: n,
          installmentTotal: 3,
        },
      });
    }

    const before = await oldRuleBalance(checking);
    expect(before).toBe(1000 - 100 - 200 + 1000 + 30 - 100 - 100);

    await runBackfill();
    const counts = async () => ({
      settlements: await env.prisma.transactionSettlement.count({ where: { userId } }),
      purchases: await env.prisma.installmentPurchase.count({ where: { userId } }),
    });
    const first = await counts();
    await runBackfill();
    expect(await counts()).toEqual(first);
    expect(first).toEqual({ settlements: 6, purchases: 1 });

    // Mesmo saldo pela regra nova (liquidações + transferências).
    expect(await env.accounts.computeBalance(checking)).toBe(before);
    expect(await env.accounts.recalculateBalance(checking)).toBe(before);

    // Registrado depois do fato: pagamento normal. Amadurecido pela data:
    // inferido e marcado para revisão.
    const originOf = async (transactionId: string) =>
      (await env.prisma.transactionSettlement.findFirst({ where: { transactionId } }))?.origin;
    expect(await originOf(recorded.id)).toBe('legacy_recorded');
    expect(await originOf(matured.id)).toBe('legacy_matured');
    expect(await originOf(futureBill.id)).toBeUndefined();
    expect(await originOf(cardPurchase.id)).toBeUndefined();

    // Futuro: previsão (recorrência) ou obrigação em aberto (avulso).
    const stored = (id: string) => env.prisma.transaction.findUniqueOrThrow({ where: { id } });
    expect(await stored(futureSalary.id)).toMatchObject({ forecast: true });
    expect(await stored(futureBill.id)).toMatchObject({ forecast: false });

    // Parcelado: a compra com data e total próprios; o fato das parcelas é a compra.
    const purchase = await env.prisma.installmentPurchase.findUniqueOrThrow({
      where: { id: purchaseSeries },
    });
    expect(purchase.purchaseDate.toISOString().slice(0, 10)).toBe(dayFromToday(-40));
    expect(Number(purchase.totalAmount)).toBe(300);
    const parcels = await env.prisma.transaction.findMany({ where: { seriesId: purchaseSeries } });
    expect(parcels.every((p) => p.purchaseId === purchaseSeries)).toBe(true);
    expect(new Set(parcels.map((p) => p.eventDate.toISOString().slice(0, 10)))).toEqual(
      new Set([dayFromToday(-40)]),
    );
  });

  it('conciliação: confirmar mantém o saldo; desfazer reabre o lançamento e recompõe o saldo', async () => {
    const review = await env.settlements.listForReview(userId);
    expect(review.meta.total).toBe(4);
    const balance = await env.balance(checking);

    const maturedBill = review.data.find(
      (s) => s.transaction.type === 'expense' && s.amount === 200,
    )!;
    await env.settlements.undoReview(userId, maturedBill.id);
    expect(await env.balance(checking)).toBe(balance + 200);
    expect(await env.transactions.findOne(userId, maturedBill.transactionId)).toMatchObject({
      state: 'open',
      isOverdue: true,
      remaining: 200,
    });

    const { confirmed } = await env.settlements.confirmAllReviews(userId);
    expect(confirmed).toBe(3);
    expect((await env.settlements.listForReview(userId)).meta.total).toBe(0);
    expect(await env.balance(checking)).toBe(balance + 200);
  });
});
