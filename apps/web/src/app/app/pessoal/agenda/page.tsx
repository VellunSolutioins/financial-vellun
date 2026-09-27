'use client';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, CheckCircle2, Circle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ReminderForm } from '@/components/reminders/ReminderForm';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { AgendaEventForm } from '@/components/agenda/AgendaEventForm';
import { useAgendaEvents, type AgendaEvent } from '@/hooks/useAgendaEvents';
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

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const REMINDER_COLOR = '#f59e0b';

function monthLabel(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const label = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** Soma/subtrai meses via aritmética inteira (evita transbordo de Date.setMonth em dias 29-31). */
function shiftMonth(month: string, delta: number) {
  const [year, monthNumber] = month.split('-').map(Number);
  const totalMonths = year * 12 + (monthNumber - 1) + delta;
  const newYear = Math.floor(totalMonths / 12);
  const newMonthIndex = ((totalMonths % 12) + 12) % 12;
  return `${newYear}-${String(newMonthIndex + 1).padStart(2, '0')}`;
}

function daysInGrid(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const startWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const totalDays = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);
  return cells;
}

function AgendaContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const selectedMonth = searchParams.get('month') ?? currentMonth();
  const toast = useToast();
  const confirm = useConfirm();

  const { data: events, loading, refetch } = useAgendaEvents(selectedMonth);
  const {
    data: allReminders,
    loading: remindersLoading,
    refetch: refetchReminders,
  } = useReminders(selectedMonth);
  const [reminderFormOpen, setReminderFormOpen] = useState(false);
  const [editingReminder, setEditingReminder] = useState<Reminder | undefined>();
  const openReminder = (reminder?: Reminder) => {
    setEditingReminder(reminder);
    setReminderFormOpen(true);
  };
  const closeReminder = () => setReminderFormOpen(false);
  const reminderSuccess = () => {
    closeReminder();
    void refetchReminders();
  };

  const [formOpen, setFormOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<AgendaEvent | undefined>();
  const [defaultDate, setDefaultDate] = useState<string | undefined>();

  const setMonth = (month: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('month', month);
    router.push(`?${params.toString()}`);
  };

  const openNew = (date?: string) => {
    setEditingEvent(undefined);
    setDefaultDate(date);
    setFormOpen(true);
  };
  const openEdit = (event: AgendaEvent) => {
    setEditingEvent(event);
    setDefaultDate(undefined);
    setFormOpen(true);
  };
  const closeForm = () => setFormOpen(false);
  const handleFormSuccess = () => {
    closeForm();
    void refetch();
  };

  const handleDelete = async (event: AgendaEvent) => {
    const ok = await confirm({
      title: 'Excluir compromisso',
      description: `Excluir "${event.title}"?`,
      confirmText: 'Excluir',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/agenda-events/${event.id}`);
      toast.success('Compromisso excluído.');
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir compromisso');
    }
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
            ? 'Pago! Vencimento já rolou para o mês seguinte.'
            : 'Marcado como pago.',
        );
      }
      void refetchReminders();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao atualizar lembrete');
    }
  };

  const handleDeleteReminder = async (reminder: Reminder) => {
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
      void refetchReminders();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir lembrete');
    }
  };

  const cells = daysInGrid(selectedMonth);
  const dayKey = (day: number) => `${selectedMonth}-${String(day).padStart(2, '0')}`;
  // Só lembretes com vencimento real dentro do mês exibido (não projeta recorrência pra outros dias).
  const remindersByDay = new Map<string, Reminder[]>();
  for (const reminder of allReminders) {
    const key = reminder.dueDate.slice(0, 10);
    if (!key.startsWith(selectedMonth)) continue;
    remindersByDay.set(key, [...(remindersByDay.get(key) ?? []), reminder]);
  }
  const eventsByDay = new Map<string, AgendaEvent[]>();
  for (const event of events) {
    const key = event.eventDate.slice(0, 10);
    eventsByDay.set(key, [...(eventsByDay.get(key) ?? []), event]);
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Agenda e Lembretes</h1>
          <p className="text-sm text-muted-foreground">
            Compromissos e vencimentos em um só lugar.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => openReminder()}>
            <Plus className="mr-1 h-4 w-4" /> Novo lembrete
          </Button>
          <Button size="sm" onClick={() => openNew()}>
            <Plus className="mr-1 h-4 w-4" />
            Novo compromisso
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-center gap-3">
        <Button size="sm" variant="ghost" onClick={() => setMonth(shiftMonth(selectedMonth, -1))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-[10rem] text-center font-medium">{monthLabel(selectedMonth)}</span>
        <Button size="sm" variant="ghost" onClick={() => setMonth(shiftMonth(selectedMonth, 1))}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto p-3 sm:p-4">
          {loading || remindersLoading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : (
            <div className="min-w-[640px]">
              <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="py-2">
                    {w}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {cells.map((day, i) => {
                  if (day === null) return <div key={`empty-${i}`} className="min-h-[92px]" />;
                  const key = dayKey(day);
                  const dayEvents = eventsByDay.get(key) ?? [];
                  const dayReminders = remindersByDay.get(key) ?? [];
                  return (
                    <div
                      key={key}
                      role="button"
                      tabIndex={0}
                      onClick={() => openNew(key)}
                      onKeyDown={(ev) => {
                        if (
                          ev.target === ev.currentTarget &&
                          (ev.key === 'Enter' || ev.key === ' ')
                        ) {
                          ev.preventDefault();
                          openNew(key);
                        }
                      }}
                      className="min-h-[92px] rounded-lg border border-border p-1.5 text-left hover:bg-muted/40"
                    >
                      <span className="text-xs font-medium">{day}</span>
                      <div className="mt-1 space-y-1">
                        {dayReminders.map((r) => (
                          <button
                            type="button"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              openReminder(r);
                            }}
                            key={r.id}
                            className="truncate rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
                            style={{ backgroundColor: REMINDER_COLOR }}
                            title={r.title}
                          >
                            {r.title}
                          </button>
                        ))}
                        {dayEvents.map((e) => (
                          <button
                            key={e.id}
                            type="button"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              openEdit(e);
                            }}
                            className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[10px] font-medium text-white"
                            style={{ backgroundColor: e.color ?? '#3b82f6' }}
                            title={e.title}
                          >
                            {e.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="font-semibold">Lembretes e contas a pagar</h2>
        <Card className="rounded-2xl">
          <CardContent className="p-0">
            {remindersLoading ? (
              <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
            ) : allReminders.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">
                Nenhum lembrete em {monthLabel(selectedMonth)}.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {allReminders.map((reminder) => {
                  const status = statusStyles[reminder.derivedStatus];
                  return (
                    <li key={reminder.id} className="flex flex-wrap items-center gap-3 p-4">
                      <button
                        type="button"
                        onClick={() => void handleTogglePaid(reminder)}
                        aria-label={
                          reminder.derivedStatus === 'paid'
                            ? 'Desmarcar como pago'
                            : 'Marcar como pago'
                        }
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
                            <Badge className="shrink-0 bg-muted text-muted-foreground">
                              Recorrente
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Vence em {formatDate(reminder.dueDate)}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-3">
                        {reminder.amount !== null && (
                          <span className="font-semibold">{formatCurrency(reminder.amount)}</span>
                        )}
                        <Badge className={status.badge}>{status.label}</Badge>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            onClick={() => openReminder(reminder)}
                          >
                            Editar
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className={cn('h-7 px-2 text-destructive')}
                            onClick={() => void handleDeleteReminder(reminder)}
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
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Compromissos do mês</h2>
        <Card className="rounded-2xl">
          <CardContent className="divide-y p-0">
            {events.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Nenhum compromisso neste mês.</p>
            ) : (
              events.map((event) => (
                <div
                  key={event.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-4"
                >
                  <div>
                    <p className="font-medium">{event.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(event.eventDate)} {event.eventTime ?? ''}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => openEdit(event)}>
                    Editar
                  </Button>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </section>
      <Dialog
        open={reminderFormOpen}
        onClose={closeReminder}
        title={editingReminder ? 'Editar lembrete' : 'Novo lembrete'}
      >
        <ReminderForm
          reminder={editingReminder}
          onSuccess={reminderSuccess}
          onCancel={closeReminder}
        />
      </Dialog>
      <Dialog
        open={formOpen}
        onClose={closeForm}
        title={editingEvent ? 'Editar compromisso' : 'Novo compromisso'}
      >
        <div className="space-y-4">
          <AgendaEventForm
            event={editingEvent}
            defaultDate={defaultDate}
            onSuccess={handleFormSuccess}
            onCancel={closeForm}
          />
          {editingEvent && (
            <Button
              variant="ghost"
              className={cn('w-full text-destructive')}
              onClick={() => void handleDelete(editingEvent).then(closeForm)}
            >
              Excluir compromisso
            </Button>
          )}
        </div>
      </Dialog>
    </div>
  );
}

export default function AgendaPage() {
  return (
    <Suspense>
      <AgendaContent />
    </Suspense>
  );
}
