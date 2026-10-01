import { Prisma } from '@prisma/client';

/**
 * Adiantamento de parcelas (docs/adrs/0017): as últimas parcelas ainda
 * futuras de uma compra são trazidas para hoje — no cartão, para a fatura
 * aberta. Cada parcela adiantada continua sendo ela mesma (mesmo número),
 * marcada com `advancedAt`.
 */

export interface AdvanceCandidate {
  id: string;
  status: string;
  installmentNumber: number | null;
  transactionDate: Date;
  amount: Prisma.Decimal | number;
  advancedAt: Date | null;
  invoice: { periodStart: Date } | null;
}

/**
 * Onde a compra está e o que pode ser adiantado, num só passe sobre as
 * parcelas confirmadas e não adiantadas (as adiantadas contam à parte).
 *
 * - `advanceable`: do fim da compra para o começo — adiantar N é pegar as N
 *   primeiras. A primeira que não é futura (ou está travada) encerra a busca:
 *   só se adianta a cauda.
 * - `blockedReason`: por que não há o que adiantar — a trava da última parcela
 *   futura (fatura paga, estorno) ou a falta de parcelas futuras.
 * - `currentNumber`: a última parcela já do mês atual (ou passada), 0 se a
 *   compra ainda não começou; `upcoming*`, a primeira de um mês seguinte.
 *
 * Futura, no cartão, é a parcela numa fatura que começa depois de hoje (a
 * aberta não conta: já é "o mês atual"). Sem fatura (conta comum, cartão sem
 * configuração, compra anterior ao controle), a de data num mês seguinte.
 */
export function advanceState<P extends AdvanceCandidate>(
  parcels: readonly P[],
  today: Date,
  blocked: ReadonlyMap<string, string>,
) {
  const desc = parcels
    .filter((p) => p.status === 'confirmed' && !p.advancedAt)
    .sort((a, b) => (b.installmentNumber ?? 0) - (a.installmentNumber ?? 0));
  const futureCount = desc.findIndex((p) => !isFuture(p, today));
  const future = futureCount === -1 ? desc : desc.slice(0, futureCount);
  const current = futureCount === -1 ? undefined : desc[futureCount];
  const upcoming = future[future.length - 1];

  const blockedAt = future.findIndex((p) => blocked.has(p.id));
  const advanceable = blockedAt === -1 ? future : future.slice(0, blockedAt);
  const blockedReason =
    advanceable.length > 0
      ? null
      : ((future[0] && blocked.get(future[0].id)) ?? 'Não há parcelas futuras para adiantar.');

  return {
    advanceable,
    blockedReason,
    currentNumber: current?.installmentNumber ?? 0,
    upcomingNumber: upcoming?.installmentNumber ?? null,
    upcomingDate: upcoming?.transactionDate ?? null,
  };
}

/**
 * Parcela de um mês seguinte ao atual. No cartão, a de uma fatura que começa
 * depois de hoje (a aberta é o mês atual, mesmo que a data da parcela caia no
 * mês que vem). Sem fatura, a de data num mês seguinte — a parcela deste mês é
 * a "atual", como na tela de Lançamentos.
 */
function isFuture(parcel: AdvanceCandidate, today: Date) {
  if (parcel.invoice) return parcel.invoice.periodStart > today;
  const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  return parcel.transactionDate >= nextMonth;
}

/**
 * Rateio de um total (com desconto) entre as parcelas, proporcional ao valor
 * de cada uma, em centavos. A sobra do arredondamento fica na última, como em
 * `installmentAmounts`. Total baixo demais pode zerar alguma parcela: quem
 * chama recusa (lançamento não tem valor zero).
 */
export function distributeAdvance(amountsCents: readonly number[], targetCents: number): number[] {
  const sum = amountsCents.reduce((acc, c) => acc + c, 0);
  if (sum === 0) return amountsCents.map(() => 0);
  const shares = amountsCents.map((c) => Math.floor((c * targetCents) / sum));
  const assigned = shares.reduce((acc, c) => acc + c, 0);
  shares[shares.length - 1] += targetCents - assigned;
  return shares;
}
