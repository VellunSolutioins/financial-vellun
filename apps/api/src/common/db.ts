import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Cliente aceito pelas operações que podem rodar dentro de uma transação de
 * banco: o `PrismaService` fora dela ou o `tx` de `$transaction(async (tx) => …)`
 * dentro. Quem grava um lançamento passa o `tx` adiante para que saldo,
 * fatura e liquidação sejam gravados no mesmo commit (docs/adrs/0018).
 */
export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Prazo das transações financeiras interativas. O padrão do Prisma (5s) é
 * curto para um parcelado longo, que cria as faturas futuras de uma vez.
 */
export const FINANCIAL_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/**
 * Trava as contas (`SELECT … FOR UPDATE`) na ordem dos ids, dentro da
 * transação de banco. Duas escritas na mesma conta passam a ser serializadas;
 * a ordem fixa evita deadlock entre, por exemplo, uma transferência A→B e
 * outra B→A ao mesmo tempo.
 */
export async function lockAccounts(tx: Db, accountIds: readonly (string | null | undefined)[]) {
  const ids = [...new Set(accountIds.filter((id): id is string => Boolean(id)))].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT "id" FROM "accounts" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
}

/** Trava um lançamento: liquidações concorrentes do mesmo lançamento esperam a vez. */
export async function lockTransaction(tx: Db, transactionId: string) {
  await tx.$queryRaw`SELECT "id" FROM "transactions" WHERE "id" = ${transactionId} FOR UPDATE`;
}

/** Trava o cartão: pagamentos e posição inicial do mesmo cartão esperam a vez. */
export async function lockCreditCard(tx: Db, creditCardId: string) {
  await tx.$queryRaw`SELECT "id" FROM "credit_cards" WHERE "id" = ${creditCardId} FOR UPDATE`;
}

/** Centavos de um `Decimal`, número ou texto, sem passar resíduo de float adiante. */
export function cents(value: number | string | { toString(): string } | null | undefined) {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value.toString()) * 100);
}
