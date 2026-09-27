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
import { cn } from '@/lib/utils';

const schema = z
  .object({
    type: z.enum(['income', 'expense'], { message: 'Selecione despesa ou receita' }),
    amount: z
      .string()
      .min(1, 'Valor obrigatório')
      .regex(CURRENCY_REGEX, 'Valor inválido')
      .refine((v) => currencyToNumber(v) > 0, 'Valor deve ser positivo'),
    description: z.string().min(1, 'Descrição obrigatória'),
    accountId: z.string().min(1, 'Conta obrigatória'),
    categoryId: z.string().optional(),
    transactionDate: z.string().min(1, 'Data obrigatória'),
    recurrenceType: z.enum(['avulso', 'fixo', 'parcelado']),
    recurrenceFrequency: z.enum(['monthly', 'bimonthly', 'semiannual', 'annual']),
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
    { message: 'Informe entre 2 e 120 repetições', path: ['recurrenceMonths'] },
  );
type FormData = z.infer<typeof schema>;

export const recurrenceLabels: Record<FormData['recurrenceType'], string> = {
  avulso: 'Única vez',
  fixo: 'Fixo (repete)',
  parcelado: 'Parcelado',
};

export const frequencyLabels: Record<FormData['recurrenceFrequency'], string> = {
  monthly: 'Mensal',
  bimonthly: 'Bimestral',
  semiannual: 'Semestral',
  annual: 'Anual',
};

const typeOptions = [
  { value: 'expense', label: 'Despesa', active: 'border-rose-600 bg-rose-600 text-white' },
  { value: 'income', label: 'Receita', active: 'border-emerald-600 bg-emerald-600 text-white' },
] as const;

interface Props {
  transaction?: Transaction;
  fixedOnly?: boolean;
  onSuccess: () => void;
  onCancel: () => void;
}

export function TransactionForm({ transaction, fixedOnly = false, onSuccess, onCancel }: Props) {
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
      type: transaction?.type ?? 'expense',
      amount: transaction ? formatCurrencyInput(Number(transaction.amount)) : '',
      description: transaction?.description ?? '',
      accountId: transaction?.accountId ?? '',
      categoryId: transaction?.categoryId ?? '',
      transactionDate: transaction?.transactionDate
        ? new Date(transaction.transactionDate).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      recurrenceType: !transaction && fixedOnly ? 'fixo' : 'avulso',
      recurrenceFrequency: 'monthly',
      installments: '',
      recurrenceMonths: '',
    },
  });

  const selectedType = watch('type');
  const selectedRecurrenceType = watch('recurrenceType');
  const watchedAmount = watch('amount');
  const watchedInstallments = watch('installments');

  // Em "parcelado" o campo Valor é o TOTAL da compra e o backend reparte — a
  // prévia existe pra ninguém digitar o valor da parcela por engano.
  const isInstallment = !transaction && selectedRecurrenceType === 'parcelado';
  const installmentPreview = (() => {
    if (!isInstallment) return null;
    const total = currencyToNumber(watchedAmount ?? '');
    const count = Number(watchedInstallments);
    if (!total || !Number.isInteger(count) || count < 2 || count > 72) return null;
    // Espelha installmentAmounts() da API: base arredondada pra baixo, última
    // parcela absorve a sobra de centavos.
    const totalCents = Math.round(total * 100);
    const baseCents = Math.floor(totalCents / count);
    const lastCents = baseCents + (totalCents - baseCents * count);
    const base = formatCurrencyInput(baseCents / 100);
    const last = formatCurrencyInput(lastCents / 100);
    return baseCents === lastCents
      ? `${count}x de R$ ${base}`
      : `${count - 1}x de R$ ${base} + última de R$ ${last}`;
  })();

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
    const { installments, recurrenceMonths, recurrenceType, recurrenceFrequency, ...rest } = data;
    const payload = transaction
      ? { ...rest, amount: currencyToNumber(data.amount) }
      : {
          ...rest,
          recurrenceType,
          amount: currencyToNumber(data.amount),
          ...(recurrenceType === 'parcelado' && { installments: Number(installments) }),
          ...(recurrenceType === 'fixo' && {
            recurrenceFrequency,
            recurrenceMonths: Number(recurrenceMonths),
          }),
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

  const filteredCategories = categories.filter((c) => c.type === selectedType);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <Label id="transaction-type-label">Tipo</Label>
        <input type="hidden" {...register('type')} />
        <div
          role="radiogroup"
          aria-labelledby="transaction-type-label"
          className="grid grid-cols-2 gap-2"
        >
          {typeOptions.map((option) => {
            const selected = selectedType === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  if (selected) return;
                  setValue('type', option.value, { shouldDirty: true, shouldValidate: true });
                  // Categoria de despesa não serve para receita (e vice-versa).
                  setValue('categoryId', '', { shouldDirty: true });
                }}
                className={cn(
                  'h-10 rounded-md border text-sm font-medium transition-colors',
                  selected
                    ? option.active
                    : 'border-input bg-background text-muted-foreground hover:bg-muted',
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {errors.type && <p className="text-xs text-destructive">{errors.type.message}</p>}
      </div>
      <div className="space-y-1">
        <Label>{isInstallment ? 'Valor total da compra (R$)' : 'Valor (R$)'}</Label>
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
          {/* Na tela de Recorrências o tipo já é "fixo" (valor padrão do form): o seletor sai. */}
          {!fixedOnly && (
            <>
              <Label>Recorrência</Label>
              <Select {...register('recurrenceType')}>
                {Object.entries(recurrenceLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </>
          )}
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
              {!errors.installments && installmentPreview && (
                <p className="pt-1 text-xs text-muted-foreground">{installmentPreview}</p>
              )}
            </div>
          )}
          {selectedRecurrenceType === 'fixo' && (
            <div className="grid grid-cols-2 gap-4 pt-1">
              <div className="space-y-1">
                <Label htmlFor="recurrence-frequency">Frequência</Label>
                <Select id="recurrence-frequency" {...register('recurrenceFrequency')}>
                  {Object.entries(frequencyLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="recurrence-count">Repetições</Label>
                <Input
                  id="recurrence-count"
                  type="number"
                  inputMode="numeric"
                  min={2}
                  max={120}
                  placeholder="Ex: 12"
                  {...register('recurrenceMonths')}
                />
              </div>
              {errors.recurrenceMonths && (
                <p className="col-span-2 text-xs text-destructive">
                  {errors.recurrenceMonths.message}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting
            ? 'Salvando...'
            : transaction
              ? 'Salvar alterações'
              : fixedOnly
                ? 'Criar recorrência'
                : 'Criar lançamento'}
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
