'use client';
import { useEffect, useState } from 'react';

import { Select } from '@/components/ui/select';
import { CategoryBars } from '@/components/dashboard/CategoryBars';
import { apiClient } from '@/lib/api-client';

export interface ChartResource {
  /** Id da conta ou do cartão (não da conta interna). */
  id: string;
  name: string;
  archived?: boolean;
}

interface Props {
  kind: 'accounts' | 'cards';
  /**
   * Contas ou cartões que o gráfico pode mostrar (já recortados pelo filtro da
   * tela); `null` enquanto a lista carrega.
   */
  resources: ChartResource[] | null;
  periodStart: string;
  periodEnd: string;
  /** Texto quando não há recurso deste tipo (ou nenhum dentro do filtro da tela). */
  emptyText: string;
}

/**
 * Os dois gráficos seguem o dinheiro (docs/adrs/0021):
 * - contas: o que saiu delas no mês, inclusive as faturas pagas, que entram
 *   na categoria "Fatura do cartão";
 * - cartões: das compras do mês, o que ainda não foi pago. Fatura paga tira
 *   as compras daqui — o valor passa a aparecer nas contas.
 */
const CHARTS = {
  accounts: {
    title: 'Saiu da conta',
    all: 'Todas as contas',
    subtitle: 'O que saiu das contas no mês, com as faturas pagas',
    path: '/dashboard/accounts-spending',
    idsParam: 'accountIds',
    empty: 'Nada saiu das contas no mês',
  },
  cards: {
    title: 'Foi no cartão',
    all: 'Todos os cartões',
    subtitle: 'Compras do mês ainda não pagas',
    path: '/dashboard/cards-unpaid',
    idsParam: 'cardIds',
    empty: 'Nada a pagar no cartão neste mês',
  },
} as const;

interface ResourceSpending {
  total: number;
  slices: {
    categoryId: string | null;
    categoryName: string;
    color: string | null;
    total: number;
  }[];
}

/**
 * Gastos por categoria só de contas ou só de cartões, no período da tela. Com
 * mais de um recurso, um seletor escolhe entre todos ou um específico.
 */
export function ResourceCategoryChart({
  kind,
  resources,
  periodStart,
  periodEnd,
  emptyText,
}: Props) {
  const chart = CHARTS[kind];
  const [selected, setSelected] = useState('');
  // Recurso que saiu da lista (ex.: filtro da tela mudou) volta para "todos".
  const current = resources?.some((r) => r.id === selected) ? selected : '';

  if (!resources || resources.length === 0) {
    return (
      <CategoryBars
        title={chart.title}
        subtitle={chart.subtitle}
        slices={resources ? [] : null}
        emptyText={emptyText}
      />
    );
  }

  const ids = current ? [current] : resources.map((r) => r.id);
  const selector =
    resources.length > 1 ? (
      <Select
        aria-label={kind === 'accounts' ? 'Conta' : 'Cartão'}
        value={current}
        onChange={(e) => setSelected(e.target.value)}
        className="h-8 w-auto max-w-[11rem] text-xs"
      >
        <option value="">{chart.all}</option>
        {resources.map((r) => (
          <option key={r.id} value={r.id}>
            {r.archived ? `${r.name} (arquivado)` : r.name}
          </option>
        ))}
      </Select>
    ) : null;

  return (
    <ResourceCategoryData
      title={chart.title}
      // Com um recurso só, o nome dele; com vários, o seletor já diz qual.
      subtitle={
        resources.length === 1 ? `${resources[0].name} · ${chart.subtitle}` : chart.subtitle
      }
      action={selector}
      emptyText={chart.empty}
      url={`${chart.path}?period_start=${periodStart}&period_end=${periodEnd}&${chart.idsParam}=${ids.join(',')}`}
    />
  );
}

/**
 * Separado para só buscar quando há ids: sem nenhum, a API devolveria vazio e
 * o gráfico diria "nada" em vez de "nenhuma conta cadastrada".
 */
function ResourceCategoryData({
  title,
  subtitle,
  action,
  emptyText,
  url,
}: {
  title: string;
  subtitle: string;
  action: React.ReactNode;
  emptyText: string;
  url: string;
}) {
  const [data, setData] = useState<ResourceSpending | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient
      .get<ResourceSpending>(url)
      .then((res) => !cancelled && setData(res))
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <CategoryBars
      title={title}
      subtitle={subtitle}
      slices={loading ? null : (data?.slices ?? [])}
      action={action}
      emptyText={data ? emptyText : 'Não foi possível carregar'}
    />
  );
}
