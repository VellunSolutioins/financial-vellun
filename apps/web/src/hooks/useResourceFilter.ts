'use client';
import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export interface ResourceSelection {
  accountIds: string[];
  cardIds: string[];
}

function parseIds(value: string | null): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

/**
 * Recorte por conta/cartão guardado na URL (`accounts=`, `cards=`), para que a
 * visão sobreviva a recarregar a página e possa ser compartilhada. Nada
 * selecionado = consolidado. Exige `<Suspense>` acima (usa `useSearchParams`).
 */
export function useResourceFilter() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const accountsParam = searchParams.get('accounts');
  const cardsParam = searchParams.get('cards');
  const selection = useMemo<ResourceSelection>(
    () => ({ accountIds: parseIds(accountsParam), cardIds: parseIds(cardsParam) }),
    [accountsParam, cardsParam],
  );

  const setSelection = useCallback(
    (next: ResourceSelection) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, ids] of [
        ['accounts', next.accountIds],
        ['cards', next.cardIds],
      ] as const) {
        if (ids.length) params.set(key, ids.join(','));
        else params.delete(key);
      }
      // Recorte novo começa da primeira página.
      params.delete('page');
      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [router, pathname, searchParams],
  );

  return { selection, setSelection };
}

/** Parâmetros de API (`accountIds`, `cardIds`) para um recorte; vazio = consolidado. */
export function resourceQuery(selection: ResourceSelection): Record<string, string> {
  return {
    ...(selection.accountIds.length && { accountIds: selection.accountIds.join(',') }),
    ...(selection.cardIds.length && { cardIds: selection.cardIds.join(',') }),
  };
}
