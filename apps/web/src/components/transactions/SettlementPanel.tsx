'use client';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import type { Transaction } from '@/hooks/useTransactions';
import type { ResourceAccount } from '@/hooks/useFinancialResources';
import { apiClient } from '@/lib/api-client';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';
import { canSettle, newIdempotencyKey, todayInputValue } from '@/lib/transaction-display';
import { formatDateBR } from '@/lib/utils';

export interface Settlement {
  id: string;
  amount: number;
  date: string;
  kind: 'payment' | 'write_off';
  status: 'active' | 'reversed';
  origin: string;
  needsReview: boolean;
  account: { id: string; name: string } | null;
}

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

const schema = z.object({
  kind: z.enum(['payment', 'write_off']),
  accountId: z.string(),
  amount: z
    .string()
    .min(1, 'Valor obrigatório')
    .regex(CURRENCY_REGEX, 'Valor inválido')
    .refine((v) => currencyToNumber(v) > 0, 'Valor deve ser positivo'),
  date: z
    .string()
    .min(1, 'Data obrigatória')
    .refine((v) => v <= todayInputValue(), 'Não pode ser uma data futura'),
});
type FormData = z.infer<typeof schema>;

const ORIGIN_LABEL: Record<string, string> = {
  user: 'Registrado por você',
  at_sight: 'À vista',
  whatsapp: 'WhatsApp',
  legacy_recorded: 'Migração',
  legacy_matured: 'Inferido na migração',
};

/**
 * Pagamentos e recebimentos de um lançamento de conta comum (docs/adrs/0018).
 * Vencer não paga nada: o saldo só muda quando o pagamento é registrado aqui.
 * Aceita pagamento parcial, de outra conta, e a dispensa do restante (desconto,
 * cobrança que não vai acontecer), que fecha o lançamento sem mexer no saldo.
 */
export function SettlementPanel({
  transaction,
  accounts,
  onChanged,
  startOpen = false,
}: {
  transaction: Transaction;
  /** Contas comuns ativas: de onde sai (ou para onde entra) o dinheiro. */
  accounts: ResourceAccount[];
  onChanged: () => void;
  /** Abre já com o formulário de pagamento (atalho "Pagar" da lista). */
  startOpen?: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [formOpen, setFormOpen] = useState(startOpen && canSettle(transaction));
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [submitting, setSubmitting] = useState(false);
  const isIncome = transaction.type === 'income';
  const remaining = transaction.remaining ?? 0;

  const load = useCallback(async () => {
    try {
      setSettlements(
        await apiClient.get<Settlement[]>(`/transactions/${transaction.id}/settlements`),
      );
    } catch {
      setSettlements([]);
    }
  }, [transaction.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      kind: 'payment',
      accountId: accounts.some((a) => a.id === transaction.accountId) ? transaction.accountId : '',
      amount: remaining > 0 ? formatCurrencyInput(remaining) : '',
      date: todayInputValue(),
    },
  });
  const kind = watch('kind');

  const onSubmit = async (data: FormData) => {
    if (data.kind === 'payment' && !data.accountId) {
      toast.error('Escolha a conta');
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post(`/transactions/${transaction.id}/settlements`, {
        kind: data.kind,
        amount: currencyToNumber(data.amount),
        date: data.date,
        ...(data.kind === 'payment' && { accountId: data.accountId }),
        idempotencyKey,
      });
      toast.success(
        data.kind === 'write_off'
          ? 'Restante dispensado.'
          : isIncome
            ? 'Recebimento registrado.'
            : 'Pagamento registrado.',
      );
      setFormOpen(false);
      setIdempotencyKey(newIdempotencyKey());
      reset();
      await load();
      onChanged();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao registrar');
    } finally {
      setSubmitting(false);
    }
  };

  const reverse = async (settlement: Settlement) => {
    const ok = await confirm({
      title: 'Reverter',
      description: `Reverter ${formatCurrency(settlement.amount)} de ${formatDateBR(settlement.date)}? O valor volta a ficar em aberto${settlement.kind === 'payment' ? ' e o saldo da conta é refeito' : ''}.`,
      confirmText: 'Reverter',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.post(
        `/transactions/${transaction.id}/settlements/${settlement.id}/reverse`,
        {},
      );
      toast.success('Revertido.');
      await load();
      onChanged();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao reverter');
    }
  };

  return (
    <section className="mt-4 space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{isIncome ? 'Recebimentos' : 'Pagamentos'}</h3>
        <p className="text-xs text-muted-foreground">
          {isIncome ? 'Recebido' : 'Pago'} {formatCurrency(transaction.settledAmount ?? 0)} ·
          restante {formatCurrency(remaining)}
        </p>
      </div>

      {settlements.length > 0 && (
        <ul className="divide-y divide-border rounded-md border text-sm">
          {settlements.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 p-2">
              <div className="min-w-0">
                <p className={s.status === 'reversed' ? 'text-muted-foreground line-through' : ''}>
                  {formatCurrency(s.amount)} · {formatDateBR(s.date)}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {s.kind === 'write_off' ? 'Dispensado' : (s.account?.name ?? '—')} ·{' '}
                  {ORIGIN_LABEL[s.origin] ?? s.origin}
                  {s.needsReview && ' · a revisar'}
                </p>
              </div>
              {s.status === 'active' ? (
                <Button size="sm" variant="ghost" onClick={() => void reverse(s)}>
                  Reverter
                </Button>
              ) : (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  Revertido
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      {canSettle(transaction) && !formOpen && (
        <Button size="sm" className="w-full sm:w-auto" onClick={() => setFormOpen(true)}>
          {isIncome ? 'Registrar recebimento' : 'Registrar pagamento'}
        </Button>
      )}

      {formOpen && (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3 rounded-md border p-3">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="O que registrar">
            {(
              [
                ['payment', isIncome ? 'Recebimento' : 'Pagamento'],
                ['write_off', 'Dispensar restante'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={kind === value}
                onClick={() => {
                  setValue('kind', value);
                  if (value === 'write_off') setValue('amount', formatCurrencyInput(remaining));
                }}
                className={
                  kind === value
                    ? 'h-9 rounded-md border border-primary bg-primary text-sm text-primary-foreground'
                    : 'h-9 rounded-md border border-input text-sm text-muted-foreground hover:bg-muted'
                }
              >
                {label}
              </button>
            ))}
          </div>
          {kind === 'payment' && (
            <div className="space-y-1">
              <Label htmlFor="settle-account">{isIncome ? 'Recebido em' : 'Pago com'}</Label>
              <Select id="settle-account" {...register('accountId')}>
                <option value="">Selecione a conta...</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="settle-amount">Valor (R$)</Label>
              <Input
                id="settle-amount"
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
              <Label htmlFor="settle-date">Data</Label>
              <Input id="settle-date" type="date" max={todayInputValue()} {...register('date')} />
              {errors.date && <p className="text-xs text-destructive">{errors.date.message}</p>}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {kind === 'write_off'
              ? 'Dispensar fecha o lançamento sem mexer no saldo: desconto, perdão ou cobrança que não vai acontecer.'
              : 'Pode ser parcial: o que faltar continua em aberto.'}
          </p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={submitting} className="flex-1">
              {submitting ? 'Salvando...' : 'Confirmar'}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setFormOpen(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
