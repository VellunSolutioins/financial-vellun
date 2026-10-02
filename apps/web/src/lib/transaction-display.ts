/**
 * Como um lançamento aparece nas listas. Estorno soma (devolve o que a compra
 * tirou); perna de transferência soma ou subtrai conforme a direção; a
 * posição inicial de um cartão é dívida (ou crédito) anterior ao controle.
 */
export type LedgerType =
  | 'income'
  | 'expense'
  | 'refund'
  | 'transfer'
  | 'opening_debt'
  | 'opening_credit';

/**
 * Estado de liquidação, calculado pela API (docs/adrs/0018). Vencer não paga
 * nada: `isOverdue` vem à parte.
 */
export type SettlementState =
  | 'forecast'
  | 'open'
  | 'partial'
  | 'settled'
  | 'on_card'
  | 'movement'
  | 'cancelled';

export interface DisplayableTransaction {
  type: LedgerType;
  transferDirection?: 'in' | 'out' | null;
  cardPaymentId?: string | null;
  accountTransferId?: string | null;
}

export function isInflow(tx: DisplayableTransaction): boolean {
  if (tx.type === 'income' || tx.type === 'refund' || tx.type === 'opening_credit') return true;
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
    case 'opening_debt':
      return 'Dívida anterior ao controle';
    case 'opening_credit':
      return 'Crédito anterior ao controle';
    default:
      if (tx.cardPaymentId) return 'Pagamento de fatura';
      if (tx.accountTransferId) return 'Transferência entre contas';
      return 'Transferência';
  }
}

/** Só receita e despesa abrem o formulário de edição; o resto abre os detalhes. */
export function isEditableEntry(tx: DisplayableTransaction): tx is { type: 'income' | 'expense' } {
  return tx.type === 'income' || tx.type === 'expense';
}

/** Rótulo do estado de liquidação; nulo quando não há o que mostrar (cartão, movimentação). */
export function settlementLabel(tx: {
  type: LedgerType;
  state?: SettlementState;
  isOverdue?: boolean;
}): { label: string; tone: 'success' | 'warning' | 'destructive' | 'outline' } | null {
  const received = tx.type === 'income';
  switch (tx.state) {
    case 'settled':
      return { label: received ? 'Recebido' : 'Pago', tone: 'success' };
    case 'partial':
      return tx.isOverdue
        ? { label: 'Parcial · vencido', tone: 'destructive' }
        : { label: received ? 'Recebido em parte' : 'Pago em parte', tone: 'warning' };
    case 'open':
      return tx.isOverdue
        ? { label: 'Vencido', tone: 'destructive' }
        : { label: received ? 'A receber' : 'A pagar', tone: 'outline' };
    case 'forecast':
      return tx.isOverdue
        ? { label: 'Previsão vencida', tone: 'warning' }
        : { label: 'Previsto', tone: 'outline' };
    default:
      return null;
  }
}

/** Pode registrar pagamento/recebimento: obrigação ou previsão de conta comum com restante. */
export function canSettle(tx: { state?: SettlementState }): boolean {
  return tx.state === 'open' || tx.state === 'partial' || tx.state === 'forecast';
}

/** Chave de idempotência por abertura de diálogo. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Dia de hoje (fuso do navegador) como `YYYY-MM-DD`, para campos de data. */
export function todayInputValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}
