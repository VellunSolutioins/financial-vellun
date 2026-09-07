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
import { useConfirm } from '@/components/ui/confirm';
import type { Transaction } from '@/hooks/useTransactions';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';

const schema = z
  .object({
    type: z.enum(['income', 'expense', 'transfer']),
    amount: z
      .string()
      .min(1, 'Valor obrigatório')
      .regex(CURRENCY_REGEX, 'Valor inválido')
      .refine((v) => currencyToNumber(v) > 0, 'Valor deve ser positivo'),
    description: z.string().min(1, 'Descrição obrigatória'),
    accountId: z.string().min(1, 'Conta obrigatória'),
    categoryId: z.string().optional(),
    transactionDate: z.string().min(1, 'Data obrigatória'),
    status: z.enum(['confirmed', 'pending']),
    recurrenceType: z.enum(['avulso', 'fixo', 'parcelado']),
    installments: z.string().optional(),
    recurrenceMonths: z.string().optional(),
  })
  .refine(
    (data) =>
      data.recurrenceType !== 'parcelado' ||
      (Number(data.installments) >= 2 && Number(data.installments) <= 72),
    { message: 'Informe entre 2 e 72 parcelas', path: ['installments'] },
  )
  .refine(
    (data) =>
      data.recurrenceType !== 'fixo' ||
      (Number(data.recurrenceMonths) >= 2 && Number(data.recurrenceMonths) <= 120),
    { message: 'Informe entre 2 e 120 meses', path: ['recurrenceMonths'] },
  );
type FormData = z.infer<typeof schema>;

const recurrenceLabels: Record<FormData['recurrenceType'], string> = {
  avulso: 'Avulso',
  fixo: 'Fixo (repete todo mês)',
  parcelado: 'Parcelado',
};

interface Props {
  transaction?: Transaction;
  defaultType?: 'income' | 'expense';
  onSuccess: () => void;
  onCancel: () => void;
}

export function TransactionForm({ transaction, defaultType, onSuccess, onCancel }: Props) {
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string; type: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      type: transaction?.type ?? defaultType ?? 'expense',
      amount: transaction ? formatCurrencyInput(Number(transaction.amount)) : '',
      description: transaction?.description ?? '',
      accountId: transaction?.accountId ?? '',
      categoryId: transaction?.categoryId ?? '',
      transactionDate: transaction?.transactionDate
        ? new Date(transaction.transactionDate).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      status: (transaction?.status as 'confirmed' | 'pending') ?? 'confirmed',
      recurrenceType: 'avulso',
      installments: '',
      recurrenceMonths: '',
    },
  });

  const selectedType = watch('type');
  const selectedRecurrenceType = watch('recurrenceType');

  useEffect(() => {
    Promise.all([
      apiClient.get<{ id: string; name: string }[]>('/accounts'),
      apiClient.get<{ id: string; name: string; type: string }[]>('/categories'),
    ])
      .then(([acc, cat]) => {
        setAccounts(acc);
        setCategories(cat);
      })
      .catch(console.error);
  }, []);

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    const { installments, recurrenceMonths, recurrenceType, ...rest } = data;
    const payload = transaction
      ? { ...rest, amount: currencyToNumber(data.amount) }
      : {
          ...rest,
          recurrenceType,
          amount: currencyToNumber(data.amount),
          ...(recurrenceType === 'parcelado' && { installments: Number(installments) }),
          ...(recurrenceType === 'fixo' && { recurrenceMonths: Number(recurrenceMonths) }),
        };
    try {
      if (transaction) {
        await apiClient.patch(`/transactions/${transaction.id}`, payload);
        toast.success('Lançamento atualizado com sucesso.');
      } else {
        await apiClient.post('/transactions', payload);
        toast.success('Lançamento criado com sucesso.');
      }
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao salvar lançamento');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!transaction) return onCancel();
    const ok = await confirm({
      title: 'Cancelar lançamento',
      description: 'O lançamento ficará com status cancelado. Deseja continuar?',
      confirmText: 'Cancelar lançamento',
      cancelText: 'Voltar',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/transactions/${transaction.id}`);
      toast.success('Lançamento cancelado.');
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao cancelar lançamento');
    }
  };

  const filteredCategories = categories.filter(
    (c) => selectedType === 'transfer' || c.type === selectedType,
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Tipo</Label>
          <Select {...register('type')}>
            <option value="income">Receita</option>
            <option value="expense">Despesa</option>
            <option value="transfer">Transferência</option>
          </Select>
          {errors.type && <p className="text-xs text-destructive">{errors.type.message}</p>}
        </div>
        <div className="space-y-1">
          <Label>Status</Label>
          <Select {...register('status')}>
            <option value="confirmed">Confirmado</option>
            <option value="pending">Pendente</option>
          </Select>
        </div>
      </div>
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
        <Label>Descrição</Label>
        <Input placeholder="Ex: Supermercado, Salário..." {...register('description')} />
        {errors.description && (
          <p className="text-xs text-destructive">{errors.description.message}</p>
        )}
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
      <div className="space-y-1">
        <Label>Data</Label>
        <Input type="date" {...register('transactionDate')} />
        {errors.transactionDate && (
          <p className="text-xs text-destructive">{errors.transactionDate.message}</p>
        )}
      </div>
      {!transaction && (
        <div className="space-y-1">
          <Label>Tipo de lançamento</Label>
          <Select {...register('recurrenceType')}>
            {Object.entries(recurrenceLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          {selectedRecurrenceType === 'parcelado' && (
            <div className="pt-1">
              <Input
                type="number"
                min={2}
                max={72}
                placeholder="Número de parcelas"
                {...register('installments')}
              />
              {errors.installments && (
                <p className="text-xs text-destructive">{errors.installments.message}</p>
              )}
            </div>
          )}
          {selectedRecurrenceType === 'fixo' && (
            <div className="pt-1">
              <Input
                type="number"
                min={2}
                max={120}
                placeholder="Repetir por quantos meses"
                {...register('recurrenceMonths')}
              />
              {errors.recurrenceMonths && (
                <p className="text-xs text-destructive">{errors.recurrenceMonths.message}</p>
              )}
            </div>
          )}
        </div>
      )}
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : transaction ? 'Salvar alterações' : 'Criar lançamento'}
        </Button>
        {transaction && (
          <Button type="button" variant="destructive" onClick={handleCancel}>
            Cancelar
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
