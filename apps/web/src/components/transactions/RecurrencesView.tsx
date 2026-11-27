'use client';
import { useState } from 'react';
import { Pause, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { PageHeading, SectionHeading } from '@/components/dashboard/home-ledger';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { FixedSummary } from '@/components/transactions/FixedSummary';
import { RecurrenceForm } from '@/components/transactions/RecurrenceForm';
import { TransactionForm, frequencyLabels } from '@/components/transactions/TransactionForm';
import { useRecurrences, type Recurrence } from '@/hooks/useRecurrences';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 10;

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

/**
 * Recorrências = séries de lançamentos fixos. "Nova recorrência" cria um
 * lançamento fixo, o mesmo registro da tela de Lançamentos; aqui só muda a
 * exibição (uma linha por série em vez de uma por ocorrência).
 */
export function RecurrencesView() {
  const { data, loading, error, refetch } = useRecurrences();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Recurrence | undefined>();
  const [page, setPage] = useState(1);
  // Incrementa a cada escrita para o resumo recarregar junto com a lista.
  const [version, setVersion] = useState(0);
  const toast = useToast();
  const confirm = useConfirm();

  const totalPages = Math.max(1, Math.ceil(data.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = data.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const afterWrite = () => {
    setCreating(false);
    setEditing(undefined);
    void refetch();
    setVersion((v) => v + 1);
  };

  const toggleActive = async (r: Recurrence) => {
    try {
      await apiClient.post(`/recurrences/${r.seriesId}/${r.isActive ? 'pause' : 'resume'}`, {});
      toast.success(r.isActive ? 'Recorrência pausada.' : 'Recorrência reativada.');
      afterWrite();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao atualizar recorrência');
    }
  };

  const handleDelete = async (r: Recurrence) => {
    const ok = await confirm({
      title: 'Excluir recorrência',
      description: `Excluir "${r.description}"? As ocorrências de hoje em diante serão removidas; as anteriores não são afetadas.`,
      confirmText: 'Excluir',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/recurrences/${r.seriesId}`);
      toast.success('Recorrência excluída.');
      afterWrite();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir recorrência');
    }
  };

  const activeCount = data.filter((r) => r.isActive).length;

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={
          <>
            <span className="text-primary">gastos fixos</span> · {activeCount}{' '}
            {activeCount === 1 ? 'ativa' : 'ativas'}
          </>
        }
        title="O que se repete"
        emphasis="todo mês"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Nova recorrência
          </Button>
        }
      />

      <FixedSummary version={version} />

      <section aria-labelledby="fixos-lista" className="space-y-3 border-t border-border pt-6">
        <SectionHeading
          id="fixos-lista"
          number={2}
          eyebrow="recorrências"
          title="Suas"
          emphasis="recorrências"
          aside={
            data.length > 0 ? (
              <span className="shrink-0 font-mono text-xs lowercase text-muted-foreground">
                {data.length} {data.length === 1 ? 'cadastrada' : 'cadastradas'}
              </span>
            ) : undefined
          }
        />
        {error ? (
          <div role="alert" className="py-6 text-sm text-destructive">
            {error}
          </div>
        ) : loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">Carregando...</div>
        ) : data.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Nenhuma recorrência cadastrada ainda.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {pageItems.map((r) => (
              <RecurrenceRow key={r.seriesId} recurrence={r} onOpen={() => setEditing(r)} />
            ))}
          </ul>
        )}
      </section>

      {data.length > PAGE_SIZE && (
        <Pagination
          page={currentPage}
          totalPages={totalPages}
          onPageChange={setPage}
          summary={`${data.length} recorrência${data.length === 1 ? '' : 's'}`}
        />
      )}

      <Dialog open={creating} onClose={() => setCreating(false)} title="Nova recorrência">
        {creating && (
          <TransactionForm fixedOnly onSuccess={afterWrite} onCancel={() => setCreating(false)} />
        )}
      </Dialog>

      <Dialog open={!!editing} onClose={() => setEditing(undefined)} title="Editar recorrência">
        {editing && (
          <>
            <RecurrenceForm
              recurrence={editing}
              onSuccess={afterWrite}
              onCancel={() => setEditing(undefined)}
            />
            {/* Pausar e excluir saíram da lista: ficam aqui, com a recorrência aberta. */}
            <div className="mt-4 flex flex-wrap justify-between gap-2 border-t border-border pt-4">
              <Button type="button" variant="outline" onClick={() => void toggleActive(editing)}>
                {editing.isActive ? 'Pausar recorrência' : 'Reativar recorrência'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="text-destructive"
                onClick={() => void handleDelete(editing)}
              >
                Excluir
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}

/**
 * Uma recorrência: a próxima data vira o selo da esquerda ("05 dez"),
 * frequência, dia, conta e categoria numa linha, e o valor à direita. Pausada,
 * fica esmaecida e sem data. Tocar abre a edição (com pausar e excluir).
 */
function RecurrenceRow({ recurrence: r, onOpen }: { recurrence: Recurrence; onOpen: () => void }) {
  const next = new Date(`${r.nextDate.slice(0, 10)}T00:00:00`);
  const details = [
    `${frequencyLabels[r.frequency].toLowerCase()} · dia ${r.dueDay}`,
    r.category?.name,
    r.isActive ? null : 'pausada',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-muted/40',
          !r.isActive && 'opacity-60',
        )}
      >
        <span
          aria-hidden
          className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl border border-border bg-card leading-none"
        >
          {r.isActive ? (
            <>
              <span className="text-base font-bold tabular-nums">
                {String(next.getDate()).padStart(2, '0')}
              </span>
              <span className="mt-0.5 font-mono text-[10px] lowercase text-muted-foreground">
                {next.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}
              </span>
            </>
          ) : (
            <Pause className="h-4 w-4 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{r.description}</span>
          <span className="block truncate text-xs text-muted-foreground">{details}</span>
        </span>
        <span
          className={cn(
            'shrink-0 text-sm font-bold tabular-nums',
            r.type === 'income' && 'text-emerald-700 dark:text-emerald-400',
          )}
        >
          {r.type === 'income' ? '+' : ''}
          {formatCurrency(r.amount)}
        </span>
      </button>
    </li>
  );
}
