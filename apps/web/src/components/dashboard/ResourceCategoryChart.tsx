'use client';
import { useState } from 'react';

import { Select } from '@/components/ui/select';
import { CategoryBars } from '@/components/dashboard/CategoryBars';
import { useTransactionSummary } from '@/hooks/useTransactionSummary';

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

const LABELS = {
  accounts: { title: 'Saiu da conta', all: 'Todas as contas' },
  cards: { title: 'Foi no cartão', all: 'Todos os cartões' },
} as const;

/**
 * Despesas por categoria só de contas ou só de cartões, no período da tela.
 * Com mais de um recurso, um seletor escolhe entre todos ou um específico.
 */
export function ResourceCategoryChart({
  kind,
  resources,
  periodStart,
  periodEnd,
  emptyText,
}: Props) {
  const labels = LABELS[kind];
  const [selected, setSelected] = useState('');
  // Recurso que saiu da lista (ex.: filtro da tela mudou) volta para "todos".
  const current = resources?.some((r) => r.id === selected) ? selected : '';

  if (!resources || resources.length === 0) {
    return (
      <CategoryBars
        title={labels.title}
        subtitle="Por categoria"
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
        <option value="">{labels.all}</option>
        {resources.map((r) => (
          <option key={r.id} value={r.id}>
            {r.archived ? `${r.name} (arquivado)` : r.name}
          </option>
        ))}
      </Select>
    ) : null;

  return (
    <ResourceCategoryData
      title={labels.title}
      // Com um recurso só, o nome dele; com vários, o seletor já diz qual.
      subtitle={resources.length === 1 ? `${resources[0].name} · por categoria` : 'Por categoria'}
      action={selector}
      query={{
        periodStart,
        periodEnd,
        ...(kind === 'accounts' ? { accountIds: ids.join(',') } : { cardIds: ids.join(',') }),
      }}
    />
  );
}

/**
 * Separado para só buscar quando há ids: sem nenhum, `/transactions/summary`
 * devolveria o consolidado, e o gráfico de cartões mostraria as contas.
 */
function ResourceCategoryData({
  title,
  subtitle,
  action,
  query,
}: {
  title: string;
  subtitle: string;
  action: React.ReactNode;
  query: { periodStart: string; periodEnd: string; accountIds?: string; cardIds?: string };
}) {
  const { data, loading } = useTransactionSummary(query);
  const slices = loading
    ? null
    : (data?.byCategory ?? [])
        .filter((c) => c.type === 'expense')
        .map((c) => ({
          categoryId: c.categoryId,
          categoryName: c.categoryName,
          color: c.color,
          total: c.total,
        }));
  return (
    <CategoryBars
      title={title}
      subtitle={subtitle}
      slices={slices}
      action={action}
      emptyText={data ? 'Sem despesas no mês' : 'Não foi possível carregar'}
    />
  );
}
