/**
 * Despesa líquida: `expense − refund`. Estorno reduz a despesa da categoria da
 * compra e nunca vira receita (docs/adrs/0015).
 */
export const NET_EXPENSE_TYPES = ['expense', 'refund'] as const;

type Grouped = {
  type: string;
  categoryId?: string | null;
  _sum: { amount: { toString(): string } | number | null };
};

const amountOf = (row: Grouped) => Number(row._sum.amount ?? 0);

/** Soma com sinal: despesa positiva, estorno negativo; outros tipos, zero. */
export function netExpenseOf(rows: readonly Grouped[]): number {
  return rows.reduce(
    (sum, row) =>
      sum + (row.type === 'expense' ? amountOf(row) : row.type === 'refund' ? -amountOf(row) : 0),
    0,
  );
}

/** Despesa líquida por categoria, a partir de linhas agrupadas por (type, categoryId). */
export function netExpenseByCategory(rows: readonly Grouped[]): Map<string | null, number> {
  const byCategory = new Map<string | null, number>();
  for (const row of rows) {
    if (row.type !== 'expense' && row.type !== 'refund') continue;
    const key = row.categoryId ?? null;
    const signed = row.type === 'refund' ? -amountOf(row) : amountOf(row);
    byCategory.set(key, (byCategory.get(key) ?? 0) + signed);
  }
  return byCategory;
}

/** Arredonda para centavos: somas de `Decimal` convertidas acumulam resíduo de float. */
export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}
