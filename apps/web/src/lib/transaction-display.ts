/**
 * Como um lançamento aparece nas listas. Estorno soma (devolve o que a compra
 * tirou); perna de pagamento de fatura soma ou subtrai conforme a direção.
 */
export type LedgerType = 'income' | 'expense' | 'refund' | 'transfer';

export interface DisplayableTransaction {
  type: LedgerType;
  transferDirection?: 'in' | 'out' | null;
}

export function isInflow(tx: DisplayableTransaction): boolean {
  if (tx.type === 'income' || tx.type === 'refund') return true;
  if (tx.type === 'transfer') return tx.transferDirection === 'in';
  return false;
}

export function signOf(tx: DisplayableTransaction): string {
  if (tx.type === 'transfer' && !tx.transferDirection) return '';
  return isInflow(tx) ? '+' : '-';
}

export function typeLabel(tx: DisplayableTransaction): string {
  switch (tx.type) {
    case 'income':
      return 'Receita';
    case 'expense':
      return 'Despesa';
    case 'refund':
      return 'Estorno';
    default:
      return tx.transferDirection ? 'Pagamento de fatura' : 'Transferência';
  }
}

/** Só receita e despesa abrem o formulário de edição; o resto abre os detalhes. */
export function isEditableEntry(tx: DisplayableTransaction): tx is { type: 'income' | 'expense' } {
  return tx.type === 'income' || tx.type === 'expense';
}

/** Chave de idempotência por abertura de diálogo. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
