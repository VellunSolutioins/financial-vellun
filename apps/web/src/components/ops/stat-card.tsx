import * as React from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Um número do resumo, com rótulo e nota opcional.
 *
 * `href` transforma o cartão em atalho para a lista já filtrada — o gesto que o
 * plantonista faz logo depois de ver o número é justamente esse.
 */
export function StatCard({
  label,
  value,
  hint,
  emphasis = false,
  action,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** Destaca o cartão quando o número exige atenção. */
  emphasis?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <Card className={cn(emphasis && 'border-destructive/50')}>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        {action}
      </CardContent>
    </Card>
  );
}
