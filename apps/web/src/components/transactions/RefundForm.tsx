'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import type { Transaction } from '@/hooks/useTransactions';
import { apiClient } from '@/lib/api-client';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';
import { cn } from '@/lib/utils';

function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

const schema = z
  .object({
    scope: z.enum(['single', 'series']),
    amount: z.string(),
    date: z.string().min(1, 'Data obrigatória'),
  })
  .refine(
    (d) =>
      d.scope === 'series' || (CURRENCY_REGEX.test(d.amount) && currencyToNumber(d.amount) > 0),
    { message: 'Valor inválido', path: ['amount'] },
  );
type FormData = z.infer<typeof schema>;

interface Props {
  transaction: Transaction;
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Estorno de uma despesa. No cartão, entra na fatura aberta na data escolhida;
 * em conta comum, devolve o valor ao saldo. Nos dois casos abate a despesa da
 * categoria da compra — não é receita.
 */
export function RefundForm({ transaction, onSuccess, onCancel }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();
  const isInstallment =
    transaction.recurrenceType === 'parcelado' && (transaction.installmentTotal ?? 0) > 1;

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      scope: 'single',
      amount: formatCurrencyInput(Number(transaction.amount)),
      date: todayLocal(),
    },
  });
  const scope = watch('scope');

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    try {
      await apiClient.post(`/transactions/${transaction.id}/refund`, {
        date: data.date,
        scope: data.scope,
        ...(data.scope === 'single' && { amount: currencyToNumber(data.amount) }),
      });
      toast.success('Estorno registrado.');
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao registrar estorno');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Estornar <strong>{transaction.description}</strong>. O estorno reduz a despesa da categoria
        da compra; não conta como receita.
      </p>

      {isInstallment && (
        <div role="radiogroup" aria-label="O que estornar" className="grid grid-cols-2 gap-2">
          {(
            [
              ['single', 'Só esta parcela'],
              ['series', 'Compra inteira'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              onClick={() => setValue('scope', value)}
              className={cn(
                'h-10 rounded-md border text-sm font-medium',
                scope === value
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input text-muted-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {scope === 'series' ? (
        <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
          Parcelas que ainda não entraram em fatura fechada ou paga são canceladas; as já faturadas
          são estornadas por inteiro na fatura aberta.
        </p>
      ) : (
        <div className="space-y-1">
          <Label htmlFor="refund-amount">Valor do estorno (R$)</Label>
          <Input
            id="refund-amount"
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
      )}
      <div className="space-y-1">
        <Label htmlFor="refund-date">Data do estorno</Label>
        <Input id="refund-date" type="date" {...register('date')} />
        {errors.date && <p className="text-xs text-destructive">{errors.date.message}</p>}
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : 'Estornar'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
