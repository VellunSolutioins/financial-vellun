'use client';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface CategoryShare {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  total: number;
  percentage: number;
}

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

function tooltipCurrency(v: unknown) {
  return typeof v === 'number' ? formatCurrency(v) : String(v);
}

const CATEGORY_COLORS = [
  '#10b981',
  '#3b82f6',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#14b8a6',
];

function colorOf(c: CategoryShare, i: number) {
  return c.color ?? CATEGORY_COLORS[i % CATEGORY_COLORS.length];
}

interface Props {
  title: string;
  subtitle?: string;
  data: CategoryShare[];
}

/** Rosca + legenda "valor · %" por categoria (Recorrências e Parcelamentos). */
export function CategoryDonut({ title, subtitle, data }: Props) {
  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <ResponsiveContainer width="100%" height={180} className="sm:max-w-[180px]">
            <PieChart>
              <Pie
                data={data}
                dataKey="total"
                nameKey="categoryName"
                innerRadius={45}
                outerRadius={75}
              >
                {data.map((c, i) => (
                  <Cell key={c.categoryId ?? `sem-${i}`} fill={colorOf(c, i)} />
                ))}
              </Pie>
              <Tooltip formatter={tooltipCurrency} />
            </PieChart>
          </ResponsiveContainer>
          <ul className="w-full space-y-2 text-sm sm:w-auto">
            {data.map((c, i) => (
              <li
                key={c.categoryId ?? `sem-${i}`}
                className="flex items-center justify-between gap-4"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: colorOf(c, i) }}
                  />
                  <span className="truncate">{c.categoryName}</span>
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {formatCurrency(c.total)} · {c.percentage.toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
