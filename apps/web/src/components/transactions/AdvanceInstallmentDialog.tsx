'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Minus, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { useInstallment, type Installment } from '@/hooks/useInstallments';
import { apiClient } from '@/lib/api-client';
import { CURRENCY_REGEX, currencyToNumber, maskCurrency } from '@/lib/masks';

const schema = z.object({
  // Opcional: vazio = sem desconto.
  amount: z
    .string()
    .refine((v) => v === '' || (CURRENCY_REGEX.test(v) && currencyToNumber(v) > 0), {
      message: 'Valor inválido',
    }),
});
type FormData = z.infer<typeof schema>;

interface Props {
  /** Compra a adiantar. Sem ela, o diálogo busca pelo `seriesId`. */
  installment?: Installment;
  seriesId?: string;
  open: boolean;
  onClose: () => void;
  onAdvanced: () => void;
}

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

const cents = (v: number) => Math.round(v * 100);

/**
 * Adiantamento de parcelas: as N últimas parcelas ainda futuras vêm para hoje
 * — no cartão, para a fatura aberta. Cada parcela continua com o número dela
 * e ganha o selo "Adiantada". Desconto opcional: o total informado é rateado
 * entre as parcelas adiantadas. A API aplica as mesmas regras.
 */
export function AdvanceInstallmentDialog({
  installment: given,
  seriesId,
  open,
  onClose,
  onAdvanced,
}: Props) {
  const toast = useToast();
  const { installment, failed } = useInstallment({ installment: given, seriesId, open });
  const [count, setCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    reset,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema), defaultValues: { amount: '' } });

  useEffect(() => {
    if (!open) return;
    setCount(1);
    reset({ amount: '' });
  }, [open, reset]);

  const available = installment?.advanceable ?? [];
  const max = available.length;
  // `advanceable` vem da última para a primeira: adiantar N = as N primeiras.
  const selected = available.slice(0, count);
  const totalCents = selected.reduce((sum, p) => sum + cents(p.amount), 0);
  const firstAdvanced = selected[selected.length - 1];
  const lastAdvanced = selected[0];
  const newLast = available[count];
  const isCard = installment?.account?.type === 'credit_card';

  const onSubmit = async (data: FormData) => {
    if (!installment) return;
    const amount = data.amount ? currencyToNumber(data.amount) : undefined;
    if (amount !== undefined && cents(amount) > totalCents) {
      setError('amount', {
        message: `O valor com desconto não pode passar de ${formatCurrency(totalCents / 100)}`,
      });
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post(`/installments/${installment.seriesId}/advance`, {
        count,
        ...(amount !== undefined && { amount }),
        // Reenvio do mesmo pedido (a cauda já mudou) é recusado pela API.
        expectedLastNumber: available[0].installmentNumber,
      });
      toast.success(count === 1 ? 'Parcela adiantada.' : `${count} parcelas adiantadas.`);
      onAdvanced();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao adiantar parcelas');
    } finally {
      setSubmitting(false);
    }
  };

  const parcelLabel = (n: number | null) => `${n}/${installment?.installmentTotal}`;

  return (
    <Dialog open={open} onClose={onClose} title="Adiantar parcelas">
      {!installment ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {failed ? 'Erro ao carregar o parcelamento.' : 'Carregando...'}
        </p>
      ) : max === 0 ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {installment.advanceBlockedReason ?? 'Não há parcelas futuras para adiantar.'}
          </p>
          <Button type="button" variant="outline" className="w-full" onClick={onClose}>
            Fechar
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">{installment.description}</strong> —{' '}
            {installment.installmentTotal}x. As parcelas adiantadas saem do fim da compra e{' '}
            {isCard ? 'entram na fatura aberta do cartão' : 'são lançadas hoje na conta'}.
          </p>

          <div className="space-y-1">
            <Label htmlFor="advance-count">Quantas parcelas adiantar</Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-10 w-10 shrink-0 p-0"
                aria-label="Menos uma parcela"
                disabled={count <= 1}
                onClick={() => setCount((c) => Math.max(1, c - 1))}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Input
                id="advance-count"
                type="number"
                inputMode="numeric"
                min={1}
                max={max}
                value={count}
                onChange={(e) => {
                  const n = Math.trunc(Number(e.target.value));
                  if (Number.isFinite(n)) setCount(Math.min(max, Math.max(1, n)));
                }}
                className="h-10 text-center"
              />
              <Button
                type="button"
                variant="outline"
                className="h-10 w-10 shrink-0 p-0"
                aria-label="Mais uma parcela"
                disabled={count >= max}
                onClick={() => setCount((c) => Math.min(max, c + 1))}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Até {max} parcela{max === 1 ? '' : 's'}.
            </p>
          </div>

          <div className="space-y-1 rounded-md bg-muted p-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">
                {count === 1
                  ? `Parcela ${parcelLabel(lastAdvanced.installmentNumber)}`
                  : `Parcelas ${firstAdvanced.installmentNumber} a ${parcelLabel(lastAdvanced.installmentNumber)}`}
              </span>
              <span className="font-semibold">{formatCurrency(totalCents / 100)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {/* Só o número: no cartão, o mês da fatura nem sempre é o da data da parcela. */}
              {newLast
                ? `A compra passa a terminar na parcela ${parcelLabel(newLast.installmentNumber)}.`
                : 'Todas as parcelas futuras ficam no mês atual.'}
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="advance-amount">Valor com desconto (R$)</Label>
            <Input
              id="advance-amount"
              inputMode="decimal"
              placeholder="0,00"
              {...register('amount')}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                const masked = maskCurrency(e.target.value);
                e.target.value = masked;
                setValue('amount', masked, { shouldDirty: true });
              }}
            />
            {errors.amount ? (
              <p className="text-xs text-destructive">{errors.amount.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Opcional. Se o banco deu desconto, informe o total a pagar; ele é dividido entre as
                parcelas adiantadas.
              </p>
            )}
          </div>

          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={submitting} className="flex-1">
              {submitting ? 'Adiantando...' : 'Adiantar'}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
