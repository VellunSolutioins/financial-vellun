'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import type { Recurrence } from '@/hooks/useRecurrences';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';

const schema = z.object({
  description: z.string().min(1, 'Descrição obrigatória'),
  amount: z
    .string()
    .min(1, 'Valor obrigatório')
    .regex(CURRENCY_REGEX, 'Valor inválido')
    .refine((v) => currencyToNumber(v) > 0, 'Valor deve ser positivo'),
  accountId: z.string().min(1, 'Conta obrigatória'),
  categoryId: z.string().optional(),
  dueDay: z
    .string()
    .min(1, 'Dia obrigatório')
    .refine((v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 31, {
      message: 'Informe um dia entre 1 e 31',
    }),
});
type FormData = z.infer<typeof schema>;

interface Props {
  recurrence: Recurrence;
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Edita as ocorrências da recorrência de hoje em diante. As passadas ficam
 * como estão; para mexer em uma só, use a tela de Lançamentos.
 */
export function RecurrenceForm({ recurrence, onSuccess, onCancel }: Props) {
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string; type: string }[]>([]);
  const toast = useToast();

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      description: recurrence.description,
      amount: formatCurrencyInput(Number(recurrence.amount)),
      accountId: recurrence.accountId,
      categoryId: recurrence.categoryId ?? '',
      dueDay: String(recurrence.dueDay),
    },
  });

  useEffect(() => {
    Promise.all([
      apiClient.get<{ id: string; name: string }[]>('/accounts'),
      apiClient.get<{ id: string; name: string; type: string }[]>('/categories'),
    ])
      .then(([acc, cat]) => {
        setAccounts(acc);
        setCategories(cat.filter((c) => c.type === recurrence.type));
      })
      .catch(console.error);
  }, [recurrence.type]);

  // As opções chegam depois do primeiro render: reaplica a seleção quando existem.
  useEffect(() => {
    if (accounts.length) setValue('accountId', recurrence.accountId);
    if (categories.length) setValue('categoryId', recurrence.categoryId ?? '');
  }, [accounts, categories, recurrence.accountId, recurrence.categoryId, setValue]);

  const onSubmit = async (data: FormData) => {
    try {
      await apiClient.patch(`/recurrences/${recurrence.seriesId}`, {
        ...data,
        amount: currencyToNumber(data.amount),
        dueDay: Number(data.dueDay),
      });
      toast.success('Recorrência atualizada.');
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao atualizar recorrência');
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        As alterações valem para as ocorrências de hoje em diante. As anteriores não mudam.
      </p>
      <div className="space-y-1">
        <Label htmlFor="recurrence-description">Descrição</Label>
        <Input id="recurrence-description" {...register('description')} />
        {errors.description && (
          <p className="text-xs text-destructive">{errors.description.message}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label htmlFor="recurrence-amount">Valor (R$)</Label>
          <Input
            id="recurrence-amount"
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
          <Label htmlFor="recurrence-due-day">Dia do vencimento</Label>
          <Input
            id="recurrence-due-day"
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            {...register('dueDay')}
          />
          {errors.dueDay && <p className="text-xs text-destructive">{errors.dueDay.message}</p>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label htmlFor="recurrence-account">Conta</Label>
          <Select id="recurrence-account" {...register('accountId')}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          {errors.accountId && (
            <p className="text-xs text-destructive">{errors.accountId.message}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="recurrence-category">Categoria</Label>
          <Select id="recurrence-category" {...register('categoryId')}>
            <option value="">Sem categoria</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={isSubmitting} className="flex-1">
          {isSubmitting ? 'Salvando...' : 'Salvar alterações'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
