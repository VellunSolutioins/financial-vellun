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
import type { Transaction } from '@/hooks/useTransactions';

const schema = z.object({
  type: z.enum(['income', 'expense', 'transfer']),
  amount: z.coerce.number().positive('Valor deve ser positivo'),
  description: z.string().min(1, 'Descrição obrigatória'),
  accountId: z.string().min(1, 'Conta obrigatória'),
  categoryId: z.string().optional(),
  transactionDate: z.string().min(1, 'Data obrigatória'),
  status: z.enum(['confirmed', 'pending']),
});
type FormData = z.infer<typeof schema>;

interface Props {
  transaction?: Transaction;
  onSuccess: () => void;
  onCancel: () => void;
}

export function TransactionForm({ transaction, onSuccess, onCancel }: Props) {
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string; type: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      type: transaction?.type ?? 'expense',
      amount: transaction ? Number(transaction.amount) : undefined,
      description: transaction?.description ?? '',
      accountId: transaction?.accountId ?? '',
      categoryId: transaction?.categoryId ?? '',
      transactionDate: transaction?.transactionDate
        ? new Date(transaction.transactionDate).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      status: (transaction?.status as 'confirmed' | 'pending') ?? 'confirmed',
    },
  });

  const selectedType = watch('type');

  useEffect(() => {
    Promise.all([
      apiClient.get<{ id: string; name: string }[]>('/accounts'),
      apiClient.get<{ id: string; name: string; type: string }[]>('/categories'),
    ]).then(([acc, cat]) => {
      setAccounts(acc);
      setCategories(cat);
    }).catch(console.error);
  }, []);

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    setError('');
    try {
      if (transaction) {
        await apiClient.patch(`/transactions/${transaction.id}`, data);
      } else {
        await apiClient.post('/transactions', data);
      }
      onSuccess();
    } catch (e: unknown) {
      if (e instanceof Error) {
        setError(e.message);
      } else {
        setError('Erro ao salvar lançamento');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!transaction) return onCancel();
    if (!confirm('Cancelar este lançamento?')) return;
    await apiClient.delete(`/transactions/${transaction.id}`);
    onSuccess();
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
        <Input type="number" step="0.01" placeholder="0,00" {...register('amount')} />
        {errors.amount && <p className="text-xs text-destructive">{errors.amount.message}</p>}
      </div>
      <div className="space-y-1">
        <Label>Descrição</Label>
        <Input placeholder="Ex: Supermercado, Salário..." {...register('description')} />
        {errors.description && <p className="text-xs text-destructive">{errors.description.message}</p>}
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
          {errors.accountId && <p className="text-xs text-destructive">{errors.accountId.message}</p>}
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
        {errors.transactionDate && <p className="text-xs text-destructive">{errors.transactionDate.message}</p>}
      </div>
      {error && <p className="text-sm text-destructive bg-destructive/10 rounded p-2">{error}</p>}
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
