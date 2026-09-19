import * as React from 'react';

import { cn } from '@/lib/utils';

export interface DefinitionItem {
  label: string;
  value: React.ReactNode;
  /** Ocupa a linha inteira — para mensagem de erro e id longo. */
  wide?: boolean;
}

/**
 * Lista de campos do detalhe.
 *
 * Uma coluna em telas estreitas, duas a partir de `sm`: rótulo acima do valor
 * continua legível em 360px, enquanto uma tabela de duas colunas não continuaria.
 */
export function DefinitionList({
  items,
  className,
}: {
  items: DefinitionItem[];
  className?: string;
}) {
  return (
    <dl className={cn('grid grid-cols-1 gap-3 text-sm sm:grid-cols-2', className)}>
      {items.map((item) => (
        <div key={item.label} className={cn('min-w-0', item.wide && 'sm:col-span-2')}>
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="break-words font-medium">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
