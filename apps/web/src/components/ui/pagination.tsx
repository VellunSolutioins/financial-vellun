import * as React from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

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
 * Navegação entre páginas: primeira, anterior, posição, próxima, última.
 *
 * Extraída do padrão duplicado em lançamentos e assinatura. Deliberadamente sem
 * números de página: com 10 itens por página (o padrão do projeto) uma régua de
 * números não cabe confortavelmente em tela estreita, e a navegação real é
 * sequencial. Em mobile os botões são só ícones; o texto de anterior/próxima
 * aparece a partir de `sm`.
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
  const atStart = disabled || page <= 1;
  const atEnd = disabled || page >= totalPages;

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      {summary ? <p className="text-sm text-muted-foreground">{summary}</p> : <span />}

      {totalPages > 1 && (
        <div className="flex items-center gap-1 sm:gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={atStart}
            onClick={() => onPageChange(1)}
            aria-label="Primeira página"
            title="Primeira página"
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={atStart}
            onClick={() => onPageChange(page - 1)}
            aria-label="Página anterior"
          >
            <ChevronLeft className="h-4 w-4 sm:-ml-1 sm:mr-1" />
            <span className="hidden sm:inline">Anterior</span>
          </Button>
          <span className="flex items-center px-2 text-sm tabular-nums text-muted-foreground sm:px-3">
            {page}/{totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={atEnd}
            onClick={() => onPageChange(page + 1)}
            aria-label="Próxima página"
          >
            <span className="hidden sm:inline">Próxima</span>
            <ChevronRight className="h-4 w-4 sm:-mr-1 sm:ml-1" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={atEnd}
            onClick={() => onPageChange(totalPages)}
            aria-label="Última página"
            title="Última página"
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
