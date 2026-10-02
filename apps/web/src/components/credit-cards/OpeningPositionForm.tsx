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
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';
import { formatDateBR } from '@/lib/utils';

const optionalCurrency = z
  .string()
  .refine((v) => v === '' || CURRENCY_REGEX.test(v), 'Valor inválido');

const schema = z.object({
  previousInvoiceAmount: optionalCurrency,
  previousInvoiceDueDate: z.string().optional(),
  credit: optionalCurrency,
});
type FormData = z.infer<typeof schema>;

/**
 * Posição do cartão no início do controle (docs/adrs/0018): a fatura anterior
 * que ainda não foi paga e o crédito que havia. Sem isso, o app não sabe dessa
 * dívida — e não presume que ela foi paga. Não é despesa: as compras que a
 * formaram aconteceram antes do controle.
 */
export function OpeningPositionForm({
  card,
  onSuccess,
  onCancel,
}: {
  card: CreditCard;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const current = card.openingPosition;
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      previousInvoiceAmount: current?.previousInvoiceAmount
        ? formatCurrencyInput(current.previousInvoiceAmount)
        : '',
      previousInvoiceDueDate: current?.previousInvoiceDueDate ?? '',
      credit: current?.credit ? formatCurrencyInput(current.credit) : '',
    },
  });

  const currencyField = (name: 'previousInvoiceAmount' | 'credit') => ({
    ...register(name),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const masked = maskCurrency(e.target.value);
      e.target.value = masked;
      setValue(name, masked, { shouldDirty: true });
    },
  });

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    try {
      await apiClient.put(`/credit-cards/${card.id}/opening-position`, {
        previousInvoiceAmount: data.previousInvoiceAmount
          ? currencyToNumber(data.previousInvoiceAmount)
          : 0,
        ...(data.previousInvoiceDueDate && { previousInvoiceDueDate: data.previousInvoiceDueDate }),
        credit: data.credit ? currencyToNumber(data.credit) : 0,
      });
      toast.success('Posição inicial salva.');
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao salvar a posição inicial');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      <p className="text-xs text-muted-foreground">
        O controle começou em{' '}
        {card.invoiceTrackingStart ? formatDateBR(card.invoiceTrackingStart) : '—'}. Informe o que
        ainda faltava pagar da fatura anterior (e o crédito, se havia). Não vira despesa, e compras
        antigas importadas depois não contam de novo.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="opening-amount">Fatura anterior não paga (R$)</Label>
          <Input
            id="opening-amount"
            inputMode="decimal"
            placeholder="0,00"
            {...currencyField('previousInvoiceAmount')}
          />
          {errors.previousInvoiceAmount && (
            <p className="text-xs text-destructive">{errors.previousInvoiceAmount.message}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="opening-due">Vencimento dela</Label>
          <Input id="opening-due" type="date" {...register('previousInvoiceDueDate')} />
          <p className="text-xs text-muted-foreground">Vazio: o que o fechamento dá.</p>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="opening-credit">Crédito no cartão (R$)</Label>
        <Input
          id="opening-credit"
          inputMode="decimal"
          placeholder="0,00"
          {...currencyField('credit')}
        />
        {errors.credit && <p className="text-xs text-destructive">{errors.credit.message}</p>}
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : 'Salvar posição inicial'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
