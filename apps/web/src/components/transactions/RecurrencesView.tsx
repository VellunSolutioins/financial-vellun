'use client';
import { useState } from 'react';
import { Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { FixedSummary } from '@/components/transactions/FixedSummary';
import { RecurrenceForm } from '@/components/transactions/RecurrenceForm';
import { TransactionForm, frequencyLabels } from '@/components/transactions/TransactionForm';
import { useRecurrences, type Recurrence } from '@/hooks/useRecurrences';
import { apiClient } from '@/lib/api-client';
import { cn, formatDateBR } from '@/lib/utils';

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

  const statusBadge = (r: Recurrence) => (
    <button
      type="button"
      onClick={() => void toggleActive(r)}
      title={r.isActive ? 'Pausar recorrência' : 'Reativar recorrência'}
    >
      <Badge
        className={cn(
          'cursor-pointer',
          r.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground',
        )}
      >
        {r.isActive ? 'Ativa' : 'Pausada'}
      </Badge>
    </button>
  );

  const actions = (r: Recurrence) => (
    <>
      <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
        Editar
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive"
        onClick={() => void handleDelete(r)}
      >
        Excluir
      </Button>
    </>
  );

  const amountClass = (r: Recurrence) =>
    cn('font-semibold', r.type === 'income' ? 'text-emerald-600' : 'text-foreground');

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Despesas Fixas e Recorrências</h1>
          <p className="text-sm text-muted-foreground">
            Lançamentos que se repetem automaticamente.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-4 w-4" />
          Nova recorrência
        </Button>
      </div>

      <FixedSummary version={version} />

      <Card className="rounded-2xl">
        <CardContent className="p-0">
          {error ? (
            <div role="alert" className="p-6 text-sm text-destructive">
              {error}
            </div>
          ) : loading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : data.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              Nenhuma recorrência cadastrada ainda.
            </div>
          ) : (
            <>
              {/* Mobile: um card por recorrência */}
              <ul className="divide-y divide-border md:hidden">
                {pageItems.map((r) => (
                  <li key={r.seriesId} className="space-y-2 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{r.description}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.type === 'income' ? 'Receita' : 'Despesa'} ·{' '}
                          {frequencyLabels[r.frequency]} · Dia {r.dueDay}
                        </p>
                      </div>
                      <span className={cn('shrink-0', amountClass(r))}>
                        {formatCurrency(r.amount)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      {statusBadge(r)}
                      <div className="-mr-2 flex">{actions(r)}</div>
                    </div>
                  </li>
                ))}
              </ul>

              {/* Tablet/desktop: tabela */}
              <table className="hidden w-full text-sm md:table">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                    <th className="p-3">Descrição</th>
                    <th className="p-3">Tipo</th>
                    <th className="p-3">Frequência</th>
                    <th className="p-3">Dia</th>
                    <th className="p-3">Próxima</th>
                    <th className="p-3 text-right">Valor</th>
                    <th className="p-3">Status</th>
                    <th className="p-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pageItems.map((r) => (
                    <tr key={r.seriesId} className="hover:bg-muted/40">
                      <td className="p-3 font-medium">{r.description}</td>
                      <td className="whitespace-nowrap p-3 text-muted-foreground">
                        {r.type === 'income' ? 'Receita' : 'Despesa'}
                      </td>
                      <td className="whitespace-nowrap p-3 text-muted-foreground">
                        {frequencyLabels[r.frequency]}
                      </td>
                      <td className="whitespace-nowrap p-3 text-muted-foreground">
                        Dia {r.dueDay}
                      </td>
                      <td className="whitespace-nowrap p-3 text-muted-foreground">
                        {r.isActive ? formatDateBR(r.nextDate) : '—'}
                      </td>
                      <td className={cn('whitespace-nowrap p-3 text-right', amountClass(r))}>
                        {formatCurrency(r.amount)}
                      </td>
                      <td className="whitespace-nowrap p-3">{statusBadge(r)}</td>
                      <td className="whitespace-nowrap p-3 text-right">{actions(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </CardContent>
      </Card>

      {data.length > 0 && (
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
          <RecurrenceForm
            recurrence={editing}
            onSuccess={afterWrite}
            onCancel={() => setEditing(undefined)}
          />
        )}
      </Dialog>
    </div>
  );
}
