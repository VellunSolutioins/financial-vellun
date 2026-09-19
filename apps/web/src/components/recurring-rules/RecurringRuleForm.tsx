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
import type { RecurringRule } from '@/hooks/useRecurringRules';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';

const schema = z.object({
  type: z.enum(['income', 'expense']),
  description: z.string().min(1, 'Descrição obrigatória'),
  amount: z
    .string()
    .min(1, 'Valor obrigatório')
    .regex(CURRENCY_REGEX, 'Valor inválido')
    .refine((v) => currencyToNumber(v) > 0, 'Valor deve ser positivo'),
  accountId: z.string().min(1, 'Conta obrigatória'),
  categoryId: z.string().optional(),
  frequency: z.enum(['monthly', 'bimonthly', 'semiannual', 'annual']),
  dueDay: z
    .string()
    .min(1, 'Dia obrigatório')
    .refine((v) => Number(v) >= 1 && Number(v) <= 28, 'Dia entre 1 e 28'),
  startDate: z.string().min(1, 'Data inicial obrigatória'),
  endDate: z.string().optional(),
});
type FormData = z.infer<typeof schema>;

const frequencyLabels: Record<FormData['frequency'], string> = {
  monthly: 'Mensal',
  bimonthly: 'Bimestral (a cada 2 meses)',
  semiannual: 'Semestral',
  annual: 'Anual',
};

interface Props {
  rule?: RecurringRule;
  defaultType?: 'income' | 'expense';
  onSuccess: () => void;
  onCancel: () => void;
}

export function RecurringRuleForm({ rule, defaultType, onSuccess, onCancel }: Props) {
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string; type: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      type: rule?.type ?? defaultType ?? 'expense',
      description: rule?.description ?? '',
      amount: rule ? formatCurrencyInput(Number(rule.amount)) : '',
      accountId: rule?.accountId ?? '',
      categoryId: rule?.categoryId ?? '',
      frequency: rule?.frequency ?? 'monthly',
      dueDay: rule ? String(rule.dueDay) : '',
      startDate: rule?.startDate
        ? rule.startDate.slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      endDate: rule?.endDate ? rule.endDate.slice(0, 10) : '',
    },
  });

  const selectedType = watch('type');

  useEffect(() => {
    Promise.all([
      apiClient.get<{ id: string; name: string }[]>('/accounts'),
      // Recorrências só existem na área Pessoal — sem o filtro explícito, o
      // dono de um plano Business recebe as categorias de Negócio aqui.
      apiClient.get<{ id: string; name: string; type: string }[]>(
        '/categories?profileType=individual',
      ),
    ])
      .then(([acc, cat]) => {
        setAccounts(acc);
        setCategories(cat);
      })
      .catch(console.error);
  }, []);

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    const payload = {
      ...data,
      amount: currencyToNumber(data.amount),
      dueDay: Number(data.dueDay),
      // null (não undefined) para os opcionais: JSON.stringify remove chaves com
      // undefined, então limpar um campo na edição nunca chegaria ao backend.
      categoryId: data.categoryId || null,
      endDate: data.endDate || null,
    };
    try {
      if (rule) {
        await apiClient.patch(`/recurring-rules/${rule.id}`, payload);
        toast.success('Recorrência atualizada com sucesso.');
      } else {
        await apiClient.post('/recurring-rules', payload);
        toast.success('Recorrência criada com sucesso.');
      }
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao salvar recorrência');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredCategories = categories.filter((c) => c.type === selectedType);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <Label>Tipo</Label>
        <Select {...register('type')}>
          <option value="income">Receita</option>
          <option value="expense">Despesa</option>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>Descrição</Label>
        <Input placeholder="Ex: Aluguel, Netflix, Salário..." {...register('description')} />
        {errors.description && (
          <p className="text-xs text-destructive">{errors.description.message}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Valor (R$)</Label>
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
          <Label>Dia do vencimento</Label>
          <Input type="number" min={1} max={28} placeholder="Ex: 5" {...register('dueDay')} />
          {errors.dueDay && <p className="text-xs text-destructive">{errors.dueDay.message}</p>}
        </div>
      </div>
      <div className="space-y-1">
        <Label>Frequência</Label>
        <Select {...register('frequency')}>
          {Object.entries(frequencyLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Conta</Label>
          <Select {...register('accountId')}>
            <option value="">Selecione...</option>
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
          <Label>Categoria</Label>
          <Select {...register('categoryId')}>
            <option value="">Sem categoria</option>
            {filteredCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Começa em</Label>
          <Input type="date" {...register('startDate')} />
          {errors.startDate && (
            <p className="text-xs text-destructive">{errors.startDate.message}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label>Termina em (opcional)</Label>
          <Input type="date" {...register('endDate')} />
        </div>
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : rule ? 'Salvar alterações' : 'Criar recorrência'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
