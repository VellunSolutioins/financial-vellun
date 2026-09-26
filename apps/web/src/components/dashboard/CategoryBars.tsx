'use client';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { categoryColor, type CategorySlice } from '@/components/dashboard/CategoryDonut';

/** Categorias visíveis antes de expandir a lista. */
const INITIAL_VISIBLE = 6;

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const percent = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** "R$ 1.800,00 · 81,8%" */
function amountAndShare(total: number, share: number) {
  return `${currency.format(total)} · ${percent.format(share)}%`;
}

interface Props {
  title: string;
  subtitle: string;
  /** `null` enquanto carrega. */
  slices: CategorySlice[] | null;
  emptyText?: string;
  /** Controle no canto do cabeçalho (ex.: seletor de conta ou cartão). */
  action?: React.ReactNode;
}

/**
 * Despesas por categoria em barras horizontais: nome e "valor · %" em cima, a
 * barra embaixo, da maior para a menor. O fundo de cada barra é 100% do total
 * do card; o preenchimento, a parte da categoria — sem largura mínima, para não
 * inflar as pequenas.
 *
 * Mesmo recorte da rosca: categoria com despesa líquida zero ou negativa
 * (estorno maior que a despesa no período) fica de fora, e o total do card é a
 * soma das que ficaram. Os percentuais usam esse total, inclusive com parte da
 * lista recolhida.
 */
export function CategoryBars({
  title,
  subtitle,
  slices,
  emptyText = 'Sem despesas no período',
  action,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  const items = (slices ?? []).filter((s) => s.total > 0).sort((a, b) => b.total - a.total);
  const total = items.reduce((sum, s) => sum + s.total, 0);
  const shareOf = (value: number) => (total > 0 ? (value / total) * 100 : 0);

  const collapsible = items.length > INITIAL_VISIBLE;
  const visible = expanded || !collapsible ? items : items.slice(0, INITIAL_VISIBLE);
  const hidden = items.slice(INITIAL_VISIBLE);
  const hiddenTotal = hidden.reduce((sum, s) => sum + s.total, 0);

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
          <div className="flex h-[120px] items-center justify-center text-sm text-muted-foreground">
            Carregando...
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-[120px] items-center justify-center text-center text-sm text-muted-foreground">
            {emptyText}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="text-xs text-muted-foreground">Total no período</p>
              <p className="text-lg font-bold sm:text-xl">{currency.format(total)}</p>
            </div>

            <ul id={listId} aria-label={`${title}: despesas por categoria`} className="space-y-3">
              {visible.map((s) => {
                const share = shareOf(s.total);
                return (
                  <li key={s.categoryId ?? 'none'} className="space-y-1.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
                      <span className="min-w-0 break-words">{s.categoryName}</span>
                      <span className="whitespace-nowrap font-medium tabular-nums text-muted-foreground">
                        {amountAndShare(s.total, share)}
                      </span>
                    </div>
                    {/* A barra repete o que o texto acima já diz: fica fora da leitura assistiva. */}
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${share}%`,
                          backgroundColor: categoryColor(s.categoryId, s.color),
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>

            {collapsible && (
              <div className="space-y-2 border-t pt-3">
                {!expanded && (
                  <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
                    <span>
                      Outras {hidden.length} categoria{hidden.length === 1 ? '' : 's'}
                    </span>
                    <span className="whitespace-nowrap font-medium tabular-nums">
                      {amountAndShare(hiddenTotal, shareOf(hiddenTotal))}
                    </span>
                  </p>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-full text-xs"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? 'Mostrar menos' : 'Ver todas as categorias'}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
