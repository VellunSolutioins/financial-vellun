import type { CardInvoice } from '@/hooks/useCreditCards';
import { formatDateBR } from '@/lib/utils';

export function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

const shortDate = (iso: string) => formatDateBR(iso, { day: '2-digit', month: '2-digit' });

/** "Novembro de 2026" a partir de `YYYY-MM` (mês do vencimento da fatura). */
export function invoiceMonthLabel(referenceMonth: string) {
  const [year, month] = referenceMonth.split('-').map(Number);
  const label = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export interface InvoiceStatus {
  label: string;
  /** Complemento em palavras do dia a dia: "fecha em 05/11", "venceu em 10/10". */
  detail: string;
  className: string;
}

/**
 * Situação da fatura em linguagem comum (docs/adrs/0020): aberta, fechada,
 * vencida, paga. O ciclo (aberta/futura) vem antes da situação de pagamento.
 */
export function invoiceStatus(invoice: CardInvoice): InvoiceStatus {
  const due = shortDate(invoice.dueDate);
  if (invoice.isOpening && invoice.remaining > 0) {
    return invoice.isOverdue
      ? { label: 'Vencida', detail: `venceu em ${due}`, className: 'bg-rose-100 text-rose-800' }
      : { label: 'Fechada', detail: `vence em ${due}`, className: 'bg-amber-100 text-amber-800' };
  }
  if (invoice.isFuture) {
    return invoice.remaining === 0 && invoice.total > 0
      ? {
          label: 'Paga',
          detail: 'paga antes de fechar',
          className: 'bg-emerald-100 text-emerald-800',
        }
      : {
          label: 'Futura',
          detail: `fecha em ${shortDate(invoice.closingDate)}`,
          className: 'bg-muted text-muted-foreground',
        };
  }
  if (invoice.isOverdue) {
    return { label: 'Vencida', detail: `venceu em ${due}`, className: 'bg-rose-100 text-rose-800' };
  }
  if (invoice.state === 'open') {
    // Paga antes do fechamento (docs/adrs/0021): continua aberta, e o que
    // entrar até o fechamento volta a aparecer como valor a pagar.
    const closes = `fecha em ${shortDate(invoice.closingDate)}`;
    if (invoice.total > 0 && invoice.remaining === 0) {
      return {
        label: 'Paga até agora',
        detail: `${closes} · novas compras ainda entram`,
        className: 'bg-emerald-100 text-emerald-800',
      };
    }
    return {
      label: 'Aberta',
      detail:
        invoice.payments > 0 ? `${closes} · ${formatCurrency(invoice.payments)} já pago` : closes,
      className: 'bg-blue-100 text-blue-800',
    };
  }
  switch (invoice.paymentStatus) {
    case 'paid':
    case 'credit':
      return {
        label: 'Paga',
        detail: `vencimento em ${due}`,
        className: 'bg-emerald-100 text-emerald-800',
      };
    case 'partial':
      return {
        label: 'Paga em parte',
        detail: `falta ${formatCurrency(invoice.remaining)} · vence em ${due}`,
        className: 'bg-amber-100 text-amber-800',
      };
    default:
      return {
        label: 'Fechada',
        detail: `vence em ${due}`,
        className: 'bg-amber-100 text-amber-800',
      };
  }
}
