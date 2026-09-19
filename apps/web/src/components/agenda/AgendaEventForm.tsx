'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import type { AgendaEvent } from '@/hooks/useAgendaEvents';
import { cn } from '@/lib/utils';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#ef4444'];

const schema = z.object({
  title: z.string().min(1, 'Título obrigatório'),
  description: z.string().optional(),
  eventDate: z.string().min(1, 'Data obrigatória'),
  eventTime: z.string().optional(),
  color: z.string(),
});
type FormData = z.infer<typeof schema>;

interface Props {
  event?: AgendaEvent;
  defaultDate?: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export function AgendaEventForm({ event, defaultDate, onSuccess, onCancel }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: event?.title ?? '',
      description: event?.description ?? '',
      eventDate: event?.eventDate ? event.eventDate.slice(0, 10) : (defaultDate ?? ''),
      eventTime: event?.eventTime ?? '',
      color: event?.color ?? COLORS[0],
    },
  });

  const selectedColor = watch('color');

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    // null (não undefined) para os opcionais: JSON.stringify remove chaves com
    // undefined, então limpar um campo na edição nunca chegaria ao backend.
    const payload = {
      title: data.title,
      description: data.description || null,
      eventDate: data.eventDate,
      eventTime: data.eventTime || null,
      color: data.color,
    };
    try {
      if (event) {
        await apiClient.patch(`/agenda-events/${event.id}`, payload);
        toast.success('Compromisso atualizado com sucesso.');
      } else {
        await apiClient.post('/agenda-events', payload);
        toast.success('Compromisso criado com sucesso.');
      }
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao salvar compromisso');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <Label>Título</Label>
        <Input placeholder="Ex: Reunião financeira, Aniversário..." {...register('title')} />
        {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Data</Label>
          <Input type="date" {...register('eventDate')} />
          {errors.eventDate && <p className="text-xs text-destructive">{errors.eventDate.message}</p>}
        </div>
        <div className="space-y-1">
          <Label>Horário (opcional)</Label>
          <Input type="time" {...register('eventTime')} />
        </div>
      </div>

      <div className="space-y-1">
        <Label>Descrição (opcional)</Label>
        <Input placeholder="Detalhes do compromisso" {...register('description')} />
      </div>

      <div className="space-y-1">
        <Label>Cor</Label>
        <div className="flex flex-wrap gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setValue('color', c, { shouldDirty: true })}
              className={cn(
                'h-7 w-7 rounded-full ring-offset-2 transition-all',
                selectedColor === c && 'ring-2 ring-foreground',
              )}
              style={{ backgroundColor: c }}
              aria-label={`Cor ${c}`}
            />
          ))}
        </div>
      </div>

      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : event ? 'Salvar alterações' : 'Criar compromisso'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
