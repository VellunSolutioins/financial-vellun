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
import type { Reminder } from '@/hooks/useReminders';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';

const schema = z.object({
  title: z.string().min(1, 'Título obrigatório'),
  amount: z
    .string()
    .optional()
    .refine((v) => !v || CURRENCY_REGEX.test(v), 'Valor inválido'),
  dueDate: z.string().min(1, 'Vencimento obrigatório'),
  isRecurrent: z.boolean(),
});
type FormData = z.infer<typeof schema>;

interface Props {
  reminder?: Reminder;
  onSuccess: () => void;
  onCancel: () => void;
}

export function ReminderForm({ reminder, onSuccess, onCancel }: Props) {
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
      title: reminder?.title ?? '',
      amount: reminder?.amount ? formatCurrencyInput(reminder.amount) : '',
      dueDate: reminder?.dueDate ? reminder.dueDate.slice(0, 10) : '',
      isRecurrent: reminder?.isRecurrent ?? false,
    },
  });

  const isRecurrent = watch('isRecurrent');

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    const payload = {
      title: data.title,
      amount: data.amount ? currencyToNumber(data.amount) : undefined,
      dueDate: data.dueDate,
      isRecurrent: data.isRecurrent,
    };
    try {
      if (reminder) {
        await apiClient.patch(`/reminders/${reminder.id}`, payload);
        toast.success('Lembrete atualizado com sucesso.');
      } else {
        await apiClient.post('/reminders', payload);
        toast.success('Lembrete criado com sucesso.');
      }
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao salvar lembrete');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <Label>Título</Label>
        <Input placeholder="Ex: Aluguel, Conta de Luz..." {...register('title')} />
        {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Valor (opcional)</Label>
          <Input
            inputMode="decimal"
            placeholder="0,00"
            {...register('amount')}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const masked = maskCurrency(e.target.value);
              e.target.value = masked;
              setValue('amount', masked, { shouldDirty: true });
            }}
          />
          {errors.amount && <p className="text-xs text-destructive">{errors.amount.message}</p>}
        </div>
        <div className="space-y-1">
          <Label>Vencimento</Label>
          <Input type="date" {...register('dueDate')} />
          {errors.dueDate && <p className="text-xs text-destructive">{errors.dueDate.message}</p>}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isRecurrent}
          onChange={(e) => setValue('isRecurrent', e.target.checked, { shouldDirty: true })}
          className="h-4 w-4 rounded border-input"
        />
        Recorrente (cria o próximo automaticamente ao marcar como pago)
      </label>

      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : reminder ? 'Salvar alterações' : 'Criar lembrete'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
