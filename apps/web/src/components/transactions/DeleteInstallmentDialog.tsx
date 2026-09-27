'use client';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import type { Installment } from '@/hooks/useInstallments';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

type Scope = 'single' | 'future' | 'all';

interface Props {
  /** Compra a excluir. Sem ela, o diálogo busca pelo `seriesId`. */
  installment?: Installment;
  seriesId?: string;
  /**
   * Parcela de onde a exclusão partiu (tela de Lançamentos): habilita a opção
   * "só esta parcela", que é a padrão nesse caso.
   */
  parcel?: { id: string; installmentNumber?: number | null };
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}

function plural(n: number, singular: string, pluralForm: string) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * Exclusão de compra parcelada: só a parcela, as de hoje em diante ou a compra
 * inteira. Opções que esbarram numa trava (fatura fechada/paga, estorno) ficam
 * desabilitadas com o motivo — a API aplica a mesma regra.
 */
export function DeleteInstallmentDialog({
  installment: given,
  seriesId,
  parcel,
  open,
  onClose,
  onDeleted,
}: Props) {
  const toast = useToast();
  const [fetched, setFetched] = useState<Installment | null>(null);
  const [scope, setScope] = useState<Scope>(parcel ? 'single' : 'all');
  const [submitting, setSubmitting] = useState(false);
  const installment = given ?? fetched;

  // Padrão: a parcela de origem; senão a compra inteira, ou as futuras se ela estiver travada.
  const defaultScope = (i: Installment | null | undefined): Scope =>
    parcel ? 'single' : i?.canDeleteAll === false ? 'future' : 'all';

  useEffect(() => {
    if (!open) return;
    setScope(defaultScope(given));
    if (given || !seriesId) return;
    setFetched(null);
    apiClient
      .get<Installment>(`/installments/${seriesId}`)
      .then((i) => {
        setFetched(i);
        setScope(defaultScope(i));
      })
      .catch(() => toast.error('Erro ao carregar o parcelamento'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, given, seriesId, parcel, toast]);

  const options: { value: Scope; label: string; hint: string; disabledReason: string | null }[] =
    installment
      ? [
          ...(parcel
            ? [
                {
                  value: 'single' as const,
                  label: 'Só esta parcela',
                  hint: parcel.installmentNumber
                    ? `Parcela ${parcel.installmentNumber}/${installment.installmentTotal}`
                    : 'As demais continuam',
                  disabledReason: null,
                },
              ]
            : []),
          {
            value: 'future',
            label: 'Parcelas de hoje em diante',
            hint: `${plural(installment.futureCount, 'parcela', 'parcelas')}; as anteriores ficam como estão`,
            disabledReason: installment.canDeleteFuture
              ? null
              : installment.deleteFutureBlockedReason,
          },
          {
            value: 'all',
            label: 'Compra inteira',
            hint: `Todas as ${plural(installment.parcelCount, 'parcela', 'parcelas')}`,
            disabledReason: installment.canDeleteAll ? null : installment.deleteAllBlockedReason,
          },
        ]
      : [];

  const selected = options.find((o) => o.value === scope);
  const canSubmit = !!selected && !selected.disabledReason && !submitting;

  const submit = async () => {
    if (!installment || !canSubmit) return;
    setSubmitting(true);
    try {
      if (scope === 'single' && parcel) {
        await apiClient.delete(`/transactions/${parcel.id}?hard_delete=true`);
        toast.success('Parcela excluída.');
      } else {
        const res = await apiClient.delete<{ deleted: number }>(
          `/installments/${installment.seriesId}?scope=${scope}`,
        );
        toast.success(`${plural(res.deleted, 'parcela excluída', 'parcelas excluídas')}.`);
      }
      onDeleted();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Excluir compra parcelada">
      {!installment ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Carregando...</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">{installment.description}</strong> —{' '}
            {installment.installmentTotal}x. O que você quer excluir?
          </p>
          <div role="radiogroup" aria-label="O que excluir" className="space-y-2">
            {options.map((o) => {
              const disabled = !!o.disabledReason;
              const checked = scope === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-disabled={disabled}
                  onClick={() => !disabled && setScope(o.value)}
                  className={cn(
                    'w-full rounded-md border p-3 text-left transition-colors',
                    checked && !disabled
                      ? 'border-destructive bg-destructive/5'
                      : 'border-input hover:bg-muted/40',
                    disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
                  )}
                >
                  <span className="block text-sm font-medium">{o.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {o.disabledReason ?? o.hint}
                  </span>
                </button>
              );
            })}
          </div>
          {!installment.canDeleteAll && (
            <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              Parcelas já faturadas não podem ser excluídas. Para desfazer a compra, use{' '}
              <strong>Estornar compra</strong>.
            </p>
          )}
          <p className="text-xs text-muted-foreground">Esta ação não pode ser desfeita.</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              className="flex-1"
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {submitting ? 'Excluindo...' : 'Excluir'}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
