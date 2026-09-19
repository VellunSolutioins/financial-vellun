import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /**
   * Contagem à esquerda, ex.: `12 lançamentos em março`. Quem chama monta a
   * frase porque só ele sabe o substantivo e o recorte.
   */
  summary?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * Navegação entre páginas: anterior, posição, próxima.
 *
 * Extraída do padrão duplicado em lançamentos e assinatura. Deliberadamente sem
 * números de página: com 10 itens por página (o padrão do projeto) uma régua de
 * números não cabe confortavelmente em tela estreita, e a navegação real é
 * sequencial.
 *
 * Só os botões somem quando há uma página única — o resumo continua, porque
 * "3 falhas" é informação mesmo sem para onde navegar.
 */
export function Pagination({
  page,
  totalPages,
  onPageChange,
  summary,
  disabled = false,
  className,
}: PaginationProps) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      {summary ? <p className="text-sm text-muted-foreground">{summary}</p> : <span />}

      {totalPages > 1 && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Anterior
          </Button>
          <span className="flex items-center px-3 text-sm text-muted-foreground">
            {page}/{totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Próxima
          </Button>
        </div>
      )}
    </div>
  );
}
