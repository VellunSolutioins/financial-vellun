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
import type { SpendingGoal } from '@/hooks/useSpendingGoals';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';

const schema = z.object({
  categoryId: z.string().min(1, 'Categoria obrigatória'),
  amount: z
    .string()
    .min(1, 'Valor obrigatório')
    .regex(CURRENCY_REGEX, 'Valor inválido')
    .refine((v) => currencyToNumber(v) > 0, 'Valor deve ser positivo'),
});
type FormData = z.infer<typeof schema>;

interface Props {
  goal?: SpendingGoal;
  existingCategoryIds: string[];
  onSuccess: () => void;
  onCancel: () => void;
}

export function SpendingGoalForm({ goal, existingCategoryIds, onSuccess, onCancel }: Props) {
  const [categories, setCategories] = useState<{ id: string; name: string; type: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      categoryId: goal?.categoryId ?? '',
      amount: goal ? formatCurrencyInput(Number(goal.amount)) : '',
    },
  });

  useEffect(() => {
    apiClient
      // Tela Pessoal — ver comentário em RecurringRuleForm sobre o filtro.
      .get<{ id: string; name: string; type: string }[]>('/categories?profileType=individual')
      .then(setCategories)
      .catch(console.error);
  }, []);

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    const amount = currencyToNumber(data.amount);
    try {
      if (goal) {
        await apiClient.patch(`/spending-goals/${goal.id}`, { amount });
        toast.success('Meta atualizada com sucesso.');
      } else {
        await apiClient.post('/spending-goals', { categoryId: data.categoryId, amount });
        toast.success('Meta criada com sucesso.');
      }
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao salvar meta');
    } finally {
      setSubmitting(false);
    }
  };

  const expenseCategories = categories.filter(
    (c) => c.type === 'expense' && (goal?.categoryId === c.id || !existingCategoryIds.includes(c.id)),
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <Label>Categoria</Label>
        <Select {...register('categoryId')} disabled={!!goal}>
          <option value="">Selecione...</option>
          {expenseCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {errors.categoryId && (
          <p className="text-xs text-destructive">{errors.categoryId.message}</p>
        )}
      </div>
      <div className="space-y-1">
        <Label>Meta mensal (R$)</Label>
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
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : goal ? 'Salvar alterações' : 'Criar meta'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
