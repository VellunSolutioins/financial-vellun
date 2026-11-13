'use client';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { useInstallment, type Installment } from '@/hooks/useInstallments';
import { apiClient } from '@/lib/api-client';
import { formatBRL } from '@/lib/billing';

interface Props {
  /** Compra a excluir. Sem ela, o diálogo busca pelo `seriesId`. */
  installment?: Installment;
  seriesId?: string;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}

/**
 * Exclusão de compra parcelada: a compra é uma operação só, então sai inteira
 * — parcela não é excluída sozinha. Parcela em fatura fechada/paga ou compra
 * com estorno travam a exclusão (o caminho é estornar a compra); pagamento
 * registrado em conta não trava: a API o reverte junto.
 */
export function DeleteInstallmentDialog({
  installment: given,
  seriesId,
  open,
  onClose,
  onDeleted,
}: Props) {
  const toast = useToast();
  const { installment, failed } = useInstallment({ installment: given, seriesId, open });
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!installment?.canDelete || submitting) return;
    setSubmitting(true);
    try {
      await apiClient.delete(`/installments/${installment.seriesId}`);
      toast.success('Compra parcelada excluída.');
      onDeleted();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir');
    } finally {
      setSubmitting(false);
    }
  };

  const onAccount = installment?.account?.type !== 'credit_card';

  return (
    <Dialog open={open} onClose={onClose} title="Excluir compra parcelada">
      {!installment ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {failed ? 'Erro ao carregar o parcelamento.' : 'Carregando...'}
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Excluir <strong className="text-foreground">{installment.description}</strong> —{' '}
            {installment.installmentTotal}x, {formatBRL(installment.totalAmount)}?{' '}
            {installment.parcelCount === 1
              ? 'A parcela sai junto.'
              : `As ${installment.parcelCount} parcelas saem juntas.`}
          </p>
          {installment.canDelete ? (
            <p className="text-xs text-muted-foreground">
              {onAccount &&
                'Pagamentos já registrados nas parcelas são desfeitos e o valor volta para o saldo da conta. '}
              Esta ação não pode ser desfeita.
            </p>
          ) : (
            <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              {installment.deleteBlockedReason} Para desfazer a compra, use{' '}
              <strong>Estornar compra</strong>.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              className="flex-1"
              disabled={!installment.canDelete || submitting}
              onClick={() => void submit()}
            >
              {submitting ? 'Excluindo...' : 'Excluir compra'}
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
