'use client';
import * as React from 'react';

import { Select, type SelectProps } from '@/components/ui/select';
import type { FinancialResources } from '@/hooks/useFinancialResources';

interface Props extends Omit<SelectProps, 'children'> {
  resources: FinancialResources | null;
  /** Primeira opção, de valor vazio (ex.: "Selecione..." ou "Todas as contas"). */
  emptyLabel?: string;
  /**
   * `entry`: para gravar um lançamento — cartão arquivado só aparece se já for o
   * valor atual. `filter`: para consultar — mostra tudo, inclusive arquivados.
   */
  purpose?: 'entry' | 'filter';
  /** Valor atual do lançamento em edição (mantém visível o cartão arquivado dele). */
  currentValue?: string;
  /** `false` esconde os cartões (ex.: receita, que cartão não recebe). */
  allowCards?: boolean;
}

/** `<option>` não aceita ícone: a estrela do preferencial vai no texto. */
const star = (preferred: boolean) => (preferred ? ' ★' : '');

/**
 * Seletor de conta ou cartão. O valor é sempre um `accountId` — no cartão, o da
 * conta interna dele —, porque é para ela que o lançamento aponta.
 */
export const ResourceSelect = React.forwardRef<HTMLSelectElement, Props>(
  (
    { resources, emptyLabel, purpose = 'entry', currentValue, allowCards = true, ...props },
    ref,
  ) => {
    const accounts = resources?.accounts ?? [];
    const cards = allowCards
      ? (resources?.cards ?? []).filter(
          (c) => purpose === 'filter' || c.isActive || c.accountId === currentValue,
        )
      : [];

    return (
      <Select ref={ref} {...props}>
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        {accounts.length > 0 && (
          <optgroup label="Contas">
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {star(a.isPreferred)}
              </option>
            ))}
          </optgroup>
        )}
        {cards.length > 0 && (
          <optgroup label="Cartões">
            {cards.map((c) => (
              <option key={c.id} value={c.accountId}>
                {c.isActive ? c.name : `${c.name} (arquivado)`}
                {star(c.isPreferred)}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
    );
  },
);
ResourceSelect.displayName = 'ResourceSelect';
