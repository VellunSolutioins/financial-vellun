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
import { CURRENCY_REGEX, currencyToNumber, maskCurrency } from '@/lib/masks';

const schema = z.object({
  amount: z
    .string()
    .min(1, 'Valor obrigatório')
    .regex(CURRENCY_REGEX, 'Valor inválido')
    .refine((v) => currencyToNumber(v) > 0, 'Valor deve ser positivo'),
  contributedAt: z.string().min(1, 'Data obrigatória'),
  note: z.string().optional(),
});
type FormData = z.infer<typeof schema>;

interface Props {
  boxId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export function ContributionForm({ boxId, onSuccess, onCancel }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { amount: '', contributedAt: new Date().toISOString().slice(0, 10), note: '' },
  });

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    try {
      await apiClient.post(`/savings-boxes/${boxId}/contributions`, {
        amount: currencyToNumber(data.amount),
        contributedAt: data.contributedAt,
        note: data.note || undefined,
      });
      toast.success('Aporte adicionado com sucesso.');
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao adicionar aporte');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <Label>Valor do aporte (R$)</Label>
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
        <Label>Data</Label>
        <Input type="date" {...register('contributedAt')} />
        {errors.contributedAt && (
          <p className="text-xs text-destructive">{errors.contributedAt.message}</p>
        )}
      </div>
      <div className="space-y-1">
        <Label>Nota (opcional)</Label>
        <Input placeholder="Ex: 13º salário" {...register('note')} />
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : 'Adicionar aporte'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
