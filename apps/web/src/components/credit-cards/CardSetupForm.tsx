'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import type { CreditCard } from '@/hooks/useCreditCards';
import { apiClient } from '@/lib/api-client';

function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

const day = z
  .string()
  .min(1, 'Dia obrigatório')
  .refine(
    (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 31,
    'Dia entre 1 e 31',
  );

const schema = z.object({
  closingDay: day,
  dueDay: day,
  invoiceTrackingStart: z
    .string()
    .min(1, 'Data obrigatória')
    .refine((v) => v <= todayLocal(), 'Não pode ser uma data futura'),
});
type FormData = z.infer<typeof schema>;

interface Props {
  card: CreditCard;
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Configuração de um cartão pendente (legado). O início do controle separa o
 * que conta como dívida do que fica como "quitado antes do controle".
 */
export function CardSetupForm({ card, onSuccess, onCancel }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      closingDay: '',
      dueDay: card.dueDay ? String(card.dueDay) : '',
      invoiceTrackingStart: `${todayLocal().slice(0, 8)}01`,
    },
  });

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    try {
      await apiClient.post(`/credit-cards/${card.id}/setup`, {
        closingDay: Number(data.closingDay),
        dueDay: Number(data.dueDay),
        invoiceTrackingStart: data.invoiceTrackingStart,
      });
      toast.success('Cartão configurado.');
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao configurar cartão');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Informe o fechamento e o vencimento de <strong>{card.name}</strong> e a partir de quando os
        lançamentos devem contar como fatura.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label htmlFor="setup-closing-day">Dia do fechamento</Label>
          <Input
            id="setup-closing-day"
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            placeholder="Ex: 3"
            {...register('closingDay')}
          />
          {errors.closingDay && (
            <p className="text-xs text-destructive">{errors.closingDay.message}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="setup-due-day">Dia do vencimento</Label>
          <Input
            id="setup-due-day"
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            placeholder="Ex: 10"
            {...register('dueDay')}
          />
          {errors.dueDay && <p className="text-xs text-destructive">{errors.dueDay.message}</p>}
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="setup-tracking-start">Controlar faturas a partir de</Label>
        <Input
          id="setup-tracking-start"
          type="date"
          max={todayLocal()}
          {...register('invoiceTrackingStart')}
        />
        {errors.invoiceTrackingStart && (
          <p className="text-xs text-destructive">{errors.invoiceTrackingStart.message}</p>
        )}
        <p className="text-xs text-muted-foreground">
          Lançamentos anteriores continuam no histórico, mas ficam como já pagos: não entram em
          fatura, dívida nem limite.
        </p>
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : 'Configurar'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
