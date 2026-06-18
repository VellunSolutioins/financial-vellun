import { PendingTransactionsView } from '@/components/transactions/PendingTransactionsView';

export default function ContasAPagarPage() {
  return (
    <PendingTransactionsView type="expense" title="Contas a Pagar" actionLabel="Marcar como pago" />
  );
}
