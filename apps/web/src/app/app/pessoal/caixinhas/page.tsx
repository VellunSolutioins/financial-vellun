'use client';
import { useState } from 'react';
import { Plus, PiggyBank } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { SavingsBoxForm } from '@/components/savings-boxes/SavingsBoxForm';
import { ContributionForm } from '@/components/savings-boxes/ContributionForm';
import { useSavingsBoxes, type SavingsBox } from '@/hooks/useSavingsBoxes';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

function formatDate(v: string) {
  return new Date(`${v.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');
}

/** Cores do selo por faixa de progresso (ver savings-boxes.service.ts). */
const progressStyles: Record<string, { bar: string; badge: string }> = {
  primeiro_passo: { bar: 'bg-slate-400', badge: 'bg-slate-100 text-slate-700' },
  avancando: { bar: 'bg-amber-500', badge: 'bg-amber-100 text-amber-700' },
  no_caminho: { bar: 'bg-blue-500', badge: 'bg-blue-100 text-blue-700' },
  acelerando: { bar: 'bg-indigo-500', badge: 'bg-indigo-100 text-indigo-700' },
  quase_la: { bar: 'bg-violet-500', badge: 'bg-violet-100 text-violet-700' },
  meta_conquistada: { bar: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-700' },
};

export default function CaixinhasPage() {
  const { data, loading, refetch } = useSavingsBoxes();
  const [formOpen, setFormOpen] = useState(false);
  const [editingBox, setEditingBox] = useState<SavingsBox | undefined>();
  const [contributingBox, setContributingBox] = useState<SavingsBox | undefined>();
  const toast = useToast();
  const confirm = useConfirm();

  const openNew = () => {
    setEditingBox(undefined);
    setFormOpen(true);
  };
  const openEdit = (box: SavingsBox) => {
    setEditingBox(box);
    setFormOpen(true);
  };
  const closeForm = () => setFormOpen(false);
  const handleFormSuccess = () => {
    closeForm();
    void refetch();
  };
  const closeContribution = () => setContributingBox(undefined);
  const handleContributionSuccess = () => {
    closeContribution();
    void refetch();
  };

  const handleDelete = async (box: SavingsBox) => {
    const ok = await confirm({
      title: 'Excluir caixinha',
      description: `Excluir "${box.name}"? Os aportes registrados também serão apagados.`,
      confirmText: 'Excluir',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/savings-boxes/${box.id}`);
      toast.success('Caixinha excluída.');
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir caixinha');
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Caixinhas</h1>
          <p className="text-sm text-muted-foreground">Objetivos de poupança e investimento.</p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="mr-1 h-4 w-4" />
          Nova caixinha
        </Button>
      </div>

      {loading ? (
        <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
      ) : data.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Nenhuma caixinha cadastrada ainda.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((box) => {
            const progress = box.progress ? progressStyles[box.progress.key] : null;
            const barWidth = box.percentage !== null ? Math.max(0, Math.min(100, box.percentage)) : 0;
            const missing =
              box.targetAmount !== null ? Math.max(0, box.targetAmount - box.saved) : null;
            return (
              <Card key={box.id} className="rounded-2xl">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white"
                        style={{ backgroundColor: box.color ?? '#94a3b8' }}
                      >
                        <PiggyBank className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{box.name}</p>
                        {box.targetDate && (
                          <p className="text-xs text-muted-foreground">Prazo: {formatDate(box.targetDate)}</p>
                        )}
                      </div>
                    </div>
                    {box.progress && progress && (
                      <Badge className={cn('shrink-0', progress.badge)}>{box.progress.label}</Badge>
                    )}
                  </div>

                  <div>
                    <span className="text-xl font-bold">{formatCurrency(box.saved)}</span>
                    {box.targetAmount !== null && (
                      <p className="text-xs text-muted-foreground">de {formatCurrency(box.targetAmount)}</p>
                    )}
                  </div>

                  {box.targetAmount !== null && (
                    <>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn('h-full rounded-full transition-all', progress?.bar)}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-muted-foreground">
                          {box.percentage?.toFixed(0)}% atingido
                        </span>
                        {missing !== null && missing > 0 && (
                          <span className="text-muted-foreground">Faltam {formatCurrency(missing)}</span>
                        )}
                      </div>
                      {box.progress && (
                        <p className="text-xs italic text-muted-foreground">{box.progress.message}</p>
                      )}
                    </>
                  )}

                  {box.yieldRate && box.yieldPeriod && (
                    <p className="text-xs text-muted-foreground">
                      Rendimento: {box.yieldRate.toLocaleString('pt-BR')}%{' '}
                      {box.yieldPeriod === 'monthly' ? 'ao mês' : 'ao ano'}
                    </p>
                  )}

                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => setContributingBox(box)}
                  >
                    Adicionar aporte
                  </Button>

                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => openEdit(box)}>
                      Editar
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-destructive"
                      onClick={() => void handleDelete(box)}
                    >
                      Excluir
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={formOpen} onClose={closeForm} title={editingBox ? 'Editar caixinha' : 'Nova caixinha'}>
        <SavingsBoxForm box={editingBox} onSuccess={handleFormSuccess} onCancel={closeForm} />
      </Dialog>

      <Dialog
        open={!!contributingBox}
        onClose={closeContribution}
        title={`Adicionar aporte — ${contributingBox?.name ?? ''}`}
      >
        {contributingBox && (
          <ContributionForm
            boxId={contributingBox.id}
            onSuccess={handleContributionSuccess}
            onCancel={closeContribution}
          />
        )}
      </Dialog>
    </div>
  );
}
