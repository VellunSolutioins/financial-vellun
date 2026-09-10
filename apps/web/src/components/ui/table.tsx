import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Uma coluna da {@link DataTable}.
 *
 * `cell` recebe a linha inteira em vez de um valor extraído porque a maioria das
 * células reais deste app combina campos (valor + sinal, ícone + nome) ou
 * renderiza ação.
 */
export interface DataTableColumn<T> {
  key: string;
  /** Vazio é legítimo: a coluna de ações não tem rótulo a anunciar. */
  header?: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  align?: 'left' | 'right';
  headerClassName?: string;
  cellClassName?: string | ((row: T) => string);
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  /** Texto de lista vazia. Cada tela diz o que falta, não um genérico. */
  empty?: React.ReactNode;
  /**
   * Largura mínima da tabela em px. Abaixo dela o contêiner rola na horizontal
   * em vez de espremer as colunas — mobile first: o conteúdo continua legível e
   * o resto se alcança rolando.
   */
  minWidth?: number;
  /** Destaque de linha sob o cursor. Desligue em tabela só de leitura. */
  hoverable?: boolean;
  className?: string;
}

/**
 * Tabela de dados com contêiner, cabeçalho, estados de carregamento e de vazio.
 *
 * Extraída do padrão que estava copiado em quatro telas (lançamentos, contatos,
 * categorias e pendências) — mesmas classes, mesma estrutura, mesmas mensagens.
 *
 * Usa **apenas tokens de cor** (`bg-card`, `bg-muted`), não `bg-white`/`bg-gray-50`.
 * Em tema claro o resultado é idêntico ao que havia; a diferença aparece no dark
 * mode, que está configurado no Tailwind e hoje é inutilizável.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  empty = 'Nenhum registro encontrado.',
  minWidth,
  hoverable = true,
  className,
}: DataTableProps<T>) {
  return (
    <div className={cn('overflow-x-auto rounded-lg border bg-card', className)}>
      {loading ? (
        <div className="p-8 text-center text-muted-foreground">Carregando...</div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-muted-foreground">{empty}</div>
      ) : (
        <table
          className="w-full text-sm"
          style={minWidth ? { minWidth: `${minWidth}px` } : undefined}
        >
          <thead className="border-b bg-muted/60">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={cn(
                    'p-3 font-medium text-muted-foreground',
                    column.align === 'right' ? 'text-right' : 'text-left',
                    column.headerClassName,
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={cn('border-b last:border-0', hoverable && 'hover:bg-muted/50')}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      'p-3',
                      column.align === 'right' && 'text-right',
                      typeof column.cellClassName === 'function'
                        ? column.cellClassName(row)
                        : column.cellClassName,
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
