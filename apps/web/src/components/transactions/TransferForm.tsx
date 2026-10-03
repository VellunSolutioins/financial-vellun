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
import type { ResourceAccount } from '@/hooks/useFinancialResources';
import { apiClient } from '@/lib/api-client';
import { CURRENCY_REGEX, currencyToNumber, maskCurrency } from '@/lib/masks';
import { newIdempotencyKey, todayInputValue } from '@/lib/transaction-display';

const optionalCurrency = z
  .string()
  .refine((v) => v === '' || CURRENCY_REGEX.test(v), 'Valor inválido');

const schema = z
  .object({
    fromAccountId: z.string().min(1, 'Escolha a conta de origem'),
    toAccountId: z.string().min(1, 'Escolha a conta de destino'),
    amount: z
      .string()
      .min(1, 'Valor obrigatório')
      .regex(CURRENCY_REGEX, 'Valor inválido')
      .refine((v) => currencyToNumber(v) > 0, 'Valor deve ser positivo'),
    date: z
      .string()
      .min(1, 'Data obrigatória')
      .refine((v) => v <= todayInputValue(), 'Não pode ser uma data futura'),
    description: z.string().optional(),
    feeAmount: optionalCurrency,
  })
  .refine((d) => d.fromAccountId !== d.toAccountId, {
    message: 'Origem e destino precisam ser contas diferentes',
    path: ['toAccountId'],
  });
type FormData = z.infer<typeof schema>;

/** O que a transferência representa, pelo tipo das contas (mesma regra da API). */
function kindOf(from?: string, to?: string) {
  if (!from || !to) return null;
  if (from === 'loan') return 'Empréstimo recebido: aumenta o caixa e a dívida, não é receita.';
  if (to === 'loan')
    return 'Amortização: reduz o caixa e a dívida, não é despesa. Juros vão à parte.';
  if (to === 'investment' && from !== 'investment')
    return 'Aporte em investimento: sai do caixa, mas não é gasto.';
  if (from === 'investment' && to !== 'investment')
    return 'Resgate de investimento: volta para o caixa, não é receita (rendimento é).';
  return 'Transferência entre contas próprias: muda os saldos, não a soma.';
}

/**
 * Transferência entre contas próprias — também aporte, resgate, empréstimo
 * recebido e amortização (docs/adrs/0018). Nunca é receita nem despesa; juros
 * ou tarifa entram à parte, como despesa de "Juros e tarifas".
 */
export function TransferForm({
  accounts,
  onSuccess,
  onCancel,
}: {
  /** Contas comuns ativas (inclui investimento e empréstimo; nunca cartão). */
  accounts: ResourceAccount[];
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      fromAccountId: '',
      toAccountId: '',
      amount: '',
      date: todayInputValue(),
      description: '',
      feeAmount: '',
    },
  });
  const typeOf = (id: string) => accounts.find((a) => a.id === id)?.type;
  const hint = kindOf(typeOf(watch('fromAccountId')), typeOf(watch('toAccountId')));

  const currencyField = (name: 'amount' | 'feeAmount') => ({
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
      await apiClient.post('/transfers', {
        fromAccountId: data.fromAccountId,
        toAccountId: data.toAccountId,
        amount: currencyToNumber(data.amount),
        date: data.date,
        ...(data.description && { description: data.description }),
        ...(data.feeAmount && { feeAmount: currencyToNumber(data.feeAmount) }),
        idempotencyKey,
      });
      toast.success('Transferência registrada.');
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao registrar transferência');
    } finally {
      setSubmitting(false);
    }
  };

  if (accounts.length < 2) {
    return (
      <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
        Cadastre pelo menos duas contas (por exemplo, a de empréstimo ou de investimento) para
        transferir entre elas.
      </p>
    );
  }

  const accountOptions = (
    <>
      <option value="">Selecione...</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </>
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="transfer-from">De</Label>
          <Select id="transfer-from" {...register('fromAccountId')}>
            {accountOptions}
          </Select>
          {errors.fromAccountId && (
            <p className="text-xs text-destructive">{errors.fromAccountId.message}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="transfer-to">Para</Label>
          <Select id="transfer-to" {...register('toAccountId')}>
            {accountOptions}
          </Select>
          {errors.toAccountId && (
            <p className="text-xs text-destructive">{errors.toAccountId.message}</p>
          )}
        </div>
      </div>
      {hint && <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">{hint}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="transfer-amount">Valor (R$)</Label>
          <Input
            id="transfer-amount"
            inputMode="decimal"
            placeholder="0,00"
            {...currencyField('amount')}
          />
          {errors.amount && <p className="text-xs text-destructive">{errors.amount.message}</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor="transfer-date">Data</Label>
          <Input id="transfer-date" type="date" max={todayInputValue()} {...register('date')} />
          {errors.date && <p className="text-xs text-destructive">{errors.date.message}</p>}
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="transfer-fee">Juros ou tarifa (R$, opcional)</Label>
        <Input
          id="transfer-fee"
          inputMode="decimal"
          placeholder="0,00"
          {...currencyField('feeAmount')}
        />
        {errors.feeAmount && <p className="text-xs text-destructive">{errors.feeAmount.message}</p>}
        <p className="text-xs text-muted-foreground">
          Separado do valor transferido: vira uma despesa em &quot;Juros e tarifas&quot;.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="transfer-description">Descrição (opcional)</Label>
        <Input id="transfer-description" {...register('description')} />
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : 'Transferir'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
