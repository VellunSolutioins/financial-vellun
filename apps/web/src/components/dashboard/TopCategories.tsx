'use client';
import { categoryColor, type CategorySlice } from '@/components/dashboard/category-color';

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Quantas categorias aparecem antes de o resto virar "Outras". */
const VISIBLE = 5;

interface Row {
  key: string;
  name: string;
  total: number;
  color: string;
}

/**
 * Resumo de "pra onde foi o dinheiro": as maiores categorias em uma linha cada
 * (nome, pontilhado e valor, com a barra embaixo) e o resto somado em "Outras". A barra é relativa à
 * maior linha, para comparar de relance; o detalhe por categoria fica na
 * análise completa.
 */
export function TopCategories({
  slices,
  label = 'Gastos do mês por categoria',
  emptyText = 'Sem gastos neste mês.',
}: {
  slices: CategorySlice[];
  label?: string;
  emptyText?: string;
}) {
  const items = slices.filter((s) => s.total > 0).sort((a, b) => b.total - a.total);
  if (items.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;
  }

  // Com uma categoria a mais que o limite, mostra todas: "Outras" com uma só não ajuda.
  const head = items.length <= VISIBLE + 1 ? items : items.slice(0, VISIBLE);
  const rest = items.slice(head.length);
  const rows: Row[] = head.map((s) => ({
    key: s.categoryId ?? 'none',
    name: s.categoryName,
    total: s.total,
    color: categoryColor(s.categoryId, s.color),
  }));
  if (rest.length > 0) {
    rows.push({
      key: 'others',
      name: `Mais ${rest.length} categorias`,
      total: rest.reduce((sum, s) => sum + s.total, 0),
      color: 'hsl(var(--muted-foreground))',
    });
  }
  const max = Math.max(...rows.map((r) => r.total));

  return (
    <ul className="space-y-4" aria-label={label}>
      {rows.map((row) => (
        <li key={row.key}>
          {/* Linha de extrato: nome, pontilhado e valor. */}
          <div className="flex items-baseline gap-2 text-sm">
            <span
              className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full"
              style={{ backgroundColor: row.color }}
              aria-hidden
            />
            <span className="min-w-0 truncate">{row.name}</span>
            <span
              className="min-w-4 flex-1 translate-y-[-3px] border-b border-dotted border-muted-foreground/40"
              aria-hidden
            />
            <span className="shrink-0 font-medium tabular-nums">{currency.format(row.total)}</span>
          </div>
          {/* A barra repete o valor: fica fora da leitura assistiva. */}
          <div className="ml-4 mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className="h-full rounded-full"
              style={{ width: `${(row.total / max) * 100}%`, backgroundColor: row.color }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
