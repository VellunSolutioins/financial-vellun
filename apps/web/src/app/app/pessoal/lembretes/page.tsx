'use client';
import { useState } from 'react';
import { Plus, CheckCircle2, Circle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { ReminderForm } from '@/components/reminders/ReminderForm';
import { useReminders, type Reminder } from '@/hooks/useReminders';
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

const statusStyles: Record<Reminder['derivedStatus'], { label: string; badge: string }> = {
  paid: { label: 'Pago', badge: 'bg-emerald-100 text-emerald-700' },
  overdue: { label: 'Vencido', badge: 'bg-rose-100 text-rose-700' },
  pending: { label: 'Pendente', badge: 'bg-amber-100 text-amber-700' },
};

export default function LembretesPage() {
  const { data, loading, refetch } = useReminders();
  const [formOpen, setFormOpen] = useState(false);
  const [editingReminder, setEditingReminder] = useState<Reminder | undefined>();
  const toast = useToast();
  const confirm = useConfirm();

  const openNew = () => {
    setEditingReminder(undefined);
    setFormOpen(true);
  };
  const openEdit = (reminder: Reminder) => {
    setEditingReminder(reminder);
    setFormOpen(true);
  };
  const closeForm = () => setFormOpen(false);
  const handleFormSuccess = () => {
    closeForm();
    void refetch();
  };

  const handleTogglePaid = async (reminder: Reminder) => {
    try {
      if (reminder.derivedStatus === 'paid') {
        await apiClient.post(`/reminders/${reminder.id}/unpay`, {});
        toast.success('Marcação de pago desfeita.');
      } else {
        await apiClient.post(`/reminders/${reminder.id}/pay`, {});
        toast.success(
          reminder.isRecurrent
            ? 'Marcado como pago — próximo lembrete já criado.'
            : 'Marcado como pago.',
        );
      }
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao atualizar lembrete');
    }
  };

  const handleDelete = async (reminder: Reminder) => {
    const ok = await confirm({
      title: 'Excluir lembrete',
      description: `Excluir "${reminder.title}"?`,
      confirmText: 'Excluir',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/reminders/${reminder.id}`);
      toast.success('Lembrete excluído.');
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir lembrete');
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Lembretes e Contas a Pagar</h1>
          <p className="text-sm text-muted-foreground">Acompanhe vencimentos e marque como pagos.</p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="mr-1 h-4 w-4" />
          Novo lembrete
        </Button>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : data.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              Nenhum lembrete cadastrado ainda.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.map((reminder) => {
                const status = statusStyles[reminder.derivedStatus];
                return (
                  <li key={reminder.id} className="flex items-center gap-3 p-4">
                    <button
                      type="button"
                      onClick={() => void handleTogglePaid(reminder)}
                      aria-label={reminder.derivedStatus === 'paid' ? 'Desmarcar como pago' : 'Marcar como pago'}
                      className="shrink-0"
                    >
                      {reminder.derivedStatus === 'paid' ? (
                        <CheckCircle2 className="h-6 w-6 fill-emerald-500 text-white" />
                      ) : (
                        <Circle className="h-6 w-6 text-muted-foreground" />
                      )}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-medium">{reminder.title}</p>
                        {reminder.isRecurrent && (
                          <Badge className="shrink-0 bg-muted text-muted-foreground">Recorrente</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">Vence em {formatDate(reminder.dueDate)}</p>
                    </div>

                    <div className="flex shrink-0 items-center gap-3">
                      {reminder.amount !== null && (
                        <span className="font-semibold">{formatCurrency(reminder.amount)}</span>
                      )}
                      <Badge className={status.badge}>{status.label}</Badge>
                      <div className="hidden gap-1 sm:flex">
                        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => openEdit(reminder)}>
                          Editar
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className={cn('h-7 px-2 text-destructive')}
                          onClick={() => void handleDelete(reminder)}
                        >
                          Excluir
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={formOpen}
        onClose={closeForm}
        title={editingReminder ? 'Editar lembrete' : 'Novo lembrete'}
      >
        <ReminderForm reminder={editingReminder} onSuccess={handleFormSuccess} onCancel={closeForm} />
      </Dialog>
    </div>
  );
}
