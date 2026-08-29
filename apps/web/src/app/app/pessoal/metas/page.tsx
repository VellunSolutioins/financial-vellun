'use client';
import { useState } from 'react';
import { Plus, Target } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { SpendingGoalForm } from '@/components/spending-goals/SpendingGoalForm';
import { useSpendingGoals, type SpendingGoal } from '@/hooks/useSpendingGoals';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

/** Cores do selo/barra por faixa de comprometimento (ver spending-goals.service.ts). */
const healthStyles: Record<string, { bar: string; badge: string; text: string }> = {
  excelente: { bar: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-700', text: 'text-emerald-600' },
  saudavel: { bar: 'bg-blue-500', badge: 'bg-blue-100 text-blue-700', text: 'text-blue-600' },
  atencao: { bar: 'bg-amber-500', badge: 'bg-amber-100 text-amber-700', text: 'text-amber-600' },
  apertado: { bar: 'bg-orange-500', badge: 'bg-orange-100 text-orange-700', text: 'text-orange-600' },
  critico: { bar: 'bg-rose-500', badge: 'bg-rose-100 text-rose-700', text: 'text-rose-600' },
};

export default function MetasPage() {
  const { data, summary, loading, refetch } = useSpendingGoals();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<SpendingGoal | undefined>();
  const toast = useToast();
  const confirm = useConfirm();

  const openNew = () => {
    setEditingGoal(undefined);
    setModalOpen(true);
  };
  const openEdit = (goal: SpendingGoal) => {
    setEditingGoal(goal);
    setModalOpen(true);
  };
  const closeModal = () => setModalOpen(false);
  const handleSuccess = () => {
    closeModal();
    void refetch();
  };

  const handleDelete = async (goal: SpendingGoal) => {
    const ok = await confirm({
      title: 'Excluir meta',
      description: `Excluir a meta de "${goal.category.name}"?`,
      confirmText: 'Excluir',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/spending-goals/${goal.id}`);
      toast.success('Meta excluída.');
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir meta');
    }
  };

  const summaryHealth = summary ? healthStyles[summary.health.key] : healthStyles.excelente;
  const summaryBarWidth = summary ? Math.max(0, Math.min(100, summary.percentage)) : 0;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Metas por Categoria</h1>
          <p className="text-sm text-muted-foreground">Acompanhe quanto já gastou em cada categoria do mês.</p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="mr-1 h-4 w-4" />
          Nova meta
        </Button>
      </div>

      {/* Orçamento total do mês */}
      <Card className="rounded-2xl">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-foreground">
                <Target className="h-4 w-4" />
              </span>
              <span className="text-sm text-muted-foreground">Orçamento total do mês</span>
            </div>
            {summary && summary.budget > 0 && (
              <Badge className={summaryHealth?.badge}>{summary.health.label}</Badge>
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold">{formatCurrency(summary?.spent ?? 0)}</span>
            <span className="text-sm text-muted-foreground">
              / {formatCurrency(summary?.budget ?? 0)} de meta
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all', summaryHealth?.bar)}
              style={{ width: `${summaryBarWidth}%` }}
            />
          </div>
          {summary && summary.budget > 0 && (
            <p className="text-xs text-muted-foreground">
              {summary.percentage.toFixed(0)}% do orçamento consumido.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Metas por categoria */}
      {loading ? (
        <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
      ) : data.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Nenhuma meta cadastrada ainda.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((goal) => {
            const health = healthStyles[goal.health.key] ?? healthStyles.excelente;
            const barWidth = Math.max(0, Math.min(100, goal.percentage));
            return (
              <Card key={goal.id} className="rounded-2xl">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: goal.category.color ?? '#94a3b8' }}
                      />
                      <span className="truncate font-medium">{goal.category.name}</span>
                    </div>
                    <Badge className={cn('shrink-0', health.badge)}>{goal.health.label}</Badge>
                  </div>
                  <div>
                    <span className="text-xl font-bold">{formatCurrency(goal.spent)}</span>
                    <p className="text-xs text-muted-foreground">de {formatCurrency(goal.amount)} de meta</p>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn('h-full rounded-full transition-all', health.bar)}
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className={cn('text-xs font-medium', health.text)}>
                      {goal.percentage.toFixed(0)}% utilizado
                    </p>
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => openEdit(goal)}>
                        Editar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-destructive"
                        onClick={() => void handleDelete(goal)}
                      >
                        Excluir
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={modalOpen} onClose={closeModal} title={editingGoal ? 'Editar meta' : 'Nova meta'}>
        <SpendingGoalForm
          goal={editingGoal}
          existingCategoryIds={data.map((g) => g.categoryId)}
          onSuccess={handleSuccess}
          onCancel={closeModal}
        />
      </Dialog>
    </div>
  );
}
