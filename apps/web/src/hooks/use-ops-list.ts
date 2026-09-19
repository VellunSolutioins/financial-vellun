'use client';

import { useCallback, useEffect, useState } from 'react';

import { OpsApiError, opsApiClient } from '@/lib/ops-api-client';
import type { Paginated } from '@/lib/ops-types';

export type OpsListParams = Record<string, string | number | undefined>;

/**
 * Monta a query descartando o que está vazio.
 *
 * Enviar `status=` vazio faria a API validar um enum inexistente e devolver 400
 * — o filtro "todos" é a **ausência** do parâmetro, não o parâmetro em branco.
 */
export function buildOpsQuery(params: OpsListParams): string {
  const query = new URLSearchParams();
  for (const [chave, valor] of Object.entries(params)) {
    if (valor === undefined || valor === null || valor === '') continue;
    query.set(chave, String(valor));
  }
  return query.toString();
}

export interface OpsListResult<T> {
  data: Paginated<T> | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Total de páginas, já arredondado — evita repetir a conta em cada tela. */
  totalPages: number;
}

/**
 * Listagem paginada de operações: falhas, pagamentos e auditoria.
 *
 * As três telas têm a mesma mecânica (filtros na URL → query → `Paginated<T>`),
 * e a diferença entre elas é só a rota e as colunas. A dependência do efeito é a
 * **string** da query, não o objeto de parâmetros: um objeto novo a cada render
 * refaria a requisição para sempre.
 */
export function useOpsList<T>(path: string, params: OpsListParams): OpsListResult<T> {
  const query = buildOpsQuery(params);
  const [data, setData] = useState<Paginated<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sufixo = query ? `?${query}` : '';
      setData(await opsApiClient.get<Paginated<T>>(`${path}${sufixo}`));
      setError(null);
    } catch (err) {
      setError(err instanceof OpsApiError ? err.message : 'Não foi possível carregar a lista.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [path, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = data ? Math.max(Math.ceil(data.total / data.pageSize), 1) : 1;

  return { data, loading, error, reload: load, totalPages };
}
