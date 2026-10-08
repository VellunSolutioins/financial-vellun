'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import type { CardInvoice } from '@/hooks/useCreditCards';
import type { ResourceAccount } from '@/hooks/useFinancialResources';
import { apiClient } from '@/lib/api-client';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';
import { newIdempotencyKey } from '@/lib/transaction-display';
import { cn, formatDateBR } from '@/lib/utils';
import { formatCurrency } from './invoice-labels';

function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

const schema = z.object({
  sourceAccountId: z.string().min(1, 'Escolha a conta de origem'),
  amount: z
    .string()
    .min(1, 'Valor obrigatório')
    .regex(CURRENCY_REGEX, 'Valor inválido')
    .refine((v) => currencyToNumber(v) > 0, 'Valor deve ser positivo'),
  paymentDate: z
    .string()
    .min(1, 'Data obrigatória')
    .refine((v) => v <= todayLocal(), 'Não pode ser uma data futura'),
});
type FormData = z.infer<typeof schema>;

interface Props {
  cardId: string;
  invoice: CardInvoice;
  /** Só contas comuns: cartão não paga cartão. */
  accounts: ResourceAccount[];
  /** Conta sugerida; sem ela (ou se não existir mais), a primeira da lista. */
  suggestedAccountId: string | null;
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Pagar fatura: sai de uma conta comum e entra no cartão. Valor padrão = o
 * restante; acima dele, o excedente vira crédito. A chave de idempotência é
 * criada quando o formulário abre — um duplo clique não paga duas vezes.
 */
export function PayInvoiceForm({
  cardId,
  invoice,
  accounts,
  suggestedAccountId,
  onSuccess,
  onCancel,
}: Props) {
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();
  const suggested = accounts.find((a) => a.id === suggestedAccountId)?.id ?? accounts[0]?.id ?? '';

  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      sourceAccountId: suggested,
      amount: invoice.remaining > 0 ? formatCurrencyInput(invoice.remaining) : '',
      paymentDate: todayLocal(),
    },
  });

  const watchedAmount = watch('amount');
  const amountCents = CURRENCY_REGEX.test(watchedAmount ?? '')
    ? Math.round(currencyToNumber(watchedAmount) * 100)
    : null;
  const remainingCents = Math.round(invoice.remaining * 100);
  const overpaid = amountCents !== null && amountCents > remainingCents;
  // Fatura do ciclo atual, ainda aberta: pagamento antes do fechamento,
  // inteiro ou em parte (docs/adrs/0021).
  const beforeClosing = invoice.state === 'open' && !invoice.isOpening;
  const payingAll = amountCents === remainingCents;

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    try {
      await apiClient.post(`/credit-cards/${cardId}/invoices/${invoice.id}/payments`, {
        sourceAccountId: data.sourceAccountId,
        amount: currencyToNumber(data.amount),
        paymentDate: data.paymentDate,
        idempotencyKey,
      });
      toast.success(
        beforeClosing
          ? 'Pagamento registrado. O limite do cartão já foi liberado.'
          : 'Pagamento registrado.',
      );
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao registrar pagamento');
    } finally {
      setSubmitting(false);
    }
  };

  if (accounts.length === 0) {
    return (
      <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
        Cadastre uma conta comum para registrar o pagamento da fatura.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3 rounded-md border p-3">
      <div className="space-y-1">
        <Label htmlFor="pay-source">Pagar com</Label>
        <Select id="pay-source" {...register('sourceAccountId')}>
          <option value="">Selecione a conta...</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        {errors.sourceAccountId && (
          <p className="text-xs text-destructive">{errors.sourceAccountId.message}</p>
        )}
      </div>
      {beforeClosing && invoice.remaining > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={payingAll}
            className={cn(payingAll && 'border-primary text-primary')}
            onClick={() =>
              setValue('amount', formatCurrencyInput(invoice.remaining), {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
          >
            Tudo até agora ({formatCurrency(invoice.remaining)})
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={!payingAll}
            className={cn(!payingAll && 'border-primary text-primary')}
            onClick={() => {
              setValue('amount', '', { shouldDirty: true });
              setFocus('amount');
            }}
          >
            Outro valor
          </Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="pay-amount">Valor (R$)</Label>
          <Input
            id="pay-amount"
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
          <Label htmlFor="pay-date">Data</Label>
          <Input id="pay-date" type="date" max={todayLocal()} {...register('paymentDate')} />
          {errors.paymentDate && (
            <p className="text-xs text-destructive">{errors.paymentDate.message}</p>
          )}
        </div>
      </div>
      {beforeClosing && (
        <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
          Esta fatura ainda está aberta: compras feitas até{' '}
          {formatDateBR(
            new Date(new Date(invoice.closingDate).getTime() - 86_400_000).toISOString(),
          )}{' '}
          ainda podem entrar nela. No fechamento, a fatura vem só com o que faltar.
        </p>
      )}
      {overpaid && (
        <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
          O que passar do valor da fatura vira crédito para a próxima.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        O valor sai do saldo da conta escolhida e aparece em Lançamentos como pagamento da fatura.
      </p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={submitting} className="flex-1">
          {submitting ? 'Pagando...' : 'Confirmar pagamento'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
