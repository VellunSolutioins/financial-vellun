'use client';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const PALETTE = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#ef4444', '#14b8a6'];
const UNCATEGORIZED_COLOR = '#94a3b8';

/**
 * Cor da categoria: a cadastrada, senão uma da paleta escolhida pelo id. Assim
 * a mesma categoria tem a mesma cor em todos os gráficos da tela — pela
 * posição na lista, "Mercado" seria verde num gráfico e azul no outro.
 */
export function categoryColor(categoryId: string | null, color?: string | null): string {
  if (color) return color;
  if (!categoryId) return UNCATEGORIZED_COLOR;
  let hash = 0;
  for (const char of categoryId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export interface CategorySlice {
  categoryId: string | null;
  categoryName: string;
  color?: string | null;
  total: number;
}

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

interface Props {
  title: string;
  subtitle: string;
  slices: CategorySlice[] | null;
  emptyText?: string;
  /** Controle no canto do cabeçalho (ex.: seletor de conta ou cartão). */
  action?: React.ReactNode;
  /** Legenda mostra no máximo este número de categorias. */
  legendLimit?: number;
}

/**
 * Rosca de despesas por categoria. Categoria com despesa líquida zero ou
 * negativa (estorno maior que a despesa no período) fica fora: não cabe numa
 * fatia.
 */
export function CategoryDonut({
  title,
  subtitle,
  slices,
  emptyText = 'Sem despesas no período',
  action,
  legendLimit = 6,
}: Props) {
  const visible = (slices ?? []).filter((s) => s.total > 0).sort((a, b) => b.total - a.total);

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="text-base">{title}</CardTitle>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {action}
      </CardHeader>
      <CardContent>
        {slices === null ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            Carregando...
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-[200px] items-center justify-center text-center text-sm text-muted-foreground">
            {emptyText}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 sm:flex-row">
            <ResponsiveContainer width="100%" height={200} className="max-w-[220px]">
              <PieChart>
                <Pie
                  data={visible}
                  dataKey="total"
                  nameKey="categoryName"
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={3}
                  stroke="none"
                >
                  {visible.map((s) => (
                    <Cell
                      key={s.categoryId ?? 'none'}
                      fill={categoryColor(s.categoryId, s.color)}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v: unknown) =>
                    typeof v === 'number' ? formatCurrency(v) : String(v)
                  }
                />
              </PieChart>
            </ResponsiveContainer>
            <ul className="w-full min-w-0 space-y-2 text-sm sm:flex-1">
              {visible.slice(0, legendLimit).map((s) => (
                <li
                  key={s.categoryId ?? 'none'}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: categoryColor(s.categoryId, s.color) }}
                    />
                    <span className="truncate">{s.categoryName}</span>
                  </span>
                  <span className="shrink-0 font-medium text-muted-foreground">
                    {formatCurrency(s.total)}
                  </span>
                </li>
              ))}
              {visible.length > legendLimit && (
                <li className="text-xs text-muted-foreground">
                  + {visible.length - legendLimit} categoria
                  {visible.length - legendLimit === 1 ? '' : 's'}
                </li>
              )}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
