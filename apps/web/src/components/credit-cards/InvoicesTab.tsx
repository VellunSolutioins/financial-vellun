'use client';
import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import { PayInvoiceForm } from '@/components/credit-cards/PayInvoiceForm';
import { useFinancialResources } from '@/hooks/useFinancialResources';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import type { CardInvoice, CardInvoiceDetail, CreditCard } from '@/hooks/useCreditCards';
import { apiClient } from '@/lib/api-client';
import { cn, formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 10;

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

export function invoiceMonthLabel(referenceMonth: string) {
  const [year, month] = referenceMonth.split('-').map(Number);
  const label = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Rótulo e tom do estado: ciclo (aberta/futura) antes da situação de pagamento. */
export function invoiceBadge(invoice: CardInvoice): { label: string; className: string } {
  if (invoice.isFuture) return { label: 'Futura', className: 'bg-muted text-muted-foreground' };
  if (invoice.state === 'open') return { label: 'Aberta', className: 'bg-blue-100 text-blue-800' };
  switch (invoice.paymentStatus) {
    case 'paid':
      return { label: 'Paga', className: 'bg-emerald-100 text-emerald-800' };
    case 'credit':
      return { label: 'Paga (crédito)', className: 'bg-emerald-100 text-emerald-800' };
    case 'partial':
      return { label: 'Paga em parte', className: 'bg-amber-100 text-amber-800' };
    default:
      return { label: 'Fechada', className: 'bg-rose-100 text-rose-800' };
  }
}

interface Props {
  card: CreditCard;
  /** Chamado quando uma ação na fatura muda os valores do cartão. */
  onChanged?: () => void;
}

/** Faturas do cartão (10 por página), o detalhe de cada uma, pagamento e reversão. */
export function InvoicesTab({ card, onChanged }: Props) {
  const [invoices, setInvoices] = useState<CardInvoice[] | null>(null);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CardInvoiceDetail | null>(null);
  const [paying, setPaying] = useState(false);
  const { data: resources } = useFinancialResources();
  const toast = useToast();
  const confirm = useConfirm();

  const load = useCallback(() => {
    apiClient
      .get<CardInvoice[]>(`/credit-cards/${card.id}/invoices`)
      .then(setInvoices)
      .catch(() => setInvoices([]));
  }, [card.id]);

  const loadDetail = useCallback(
    (invoiceId: string) => {
      setDetail(null);
      apiClient
        .get<CardInvoiceDetail>(`/credit-cards/${card.id}/invoices/${invoiceId}`)
        .then(setDetail)
        .catch(() => setOpenId(null));
    },
    [card.id],
  );

  useEffect(load, [load]);
  useEffect(() => {
    setPaying(false);
    if (openId) loadDetail(openId);
  }, [openId, loadDetail]);

  const reloadAll = () => {
    load();
    if (openId) loadDetail(openId);
    onChanged?.();
  };

  const reversePayment = async (paymentId: string) => {
    if (!detail) return;
    const ok = await confirm({
      title: 'Reverter pagamento',
      description:
        'O valor volta para a conta de origem e a fatura fica em aberto de novo. O pagamento continua no histórico como revertido.',
      confirmText: 'Reverter',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.post(
        `/credit-cards/${card.id}/invoices/${detail.id}/payments/${paymentId}/reverse`,
        {},
      );
      toast.success('Pagamento revertido.');
      reloadAll();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao reverter pagamento');
    }
  };

  if (invoices === null) {
    return <p className="p-6 text-center text-sm text-muted-foreground">Carregando...</p>;
  }
  if (invoices.length === 0) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          Nenhuma fatura ainda. Ela aparece quando a primeira compra cai no ciclo.
        </CardContent>
      </Card>
    );
  }

  const totalPages = Math.max(1, Math.ceil(invoices.length / PAGE_SIZE));
  const visible = invoices.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="p-0">
          <ul className="divide-y">
            {visible.map((invoice) => {
              const badge = invoiceBadge(invoice);
              return (
                <li key={invoice.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(invoice.id)}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 p-3 text-left transition-colors hover:bg-muted/40',
                      invoice.isCurrent && 'bg-blue-50/40',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate text-sm font-medium">
                          {invoiceMonthLabel(invoice.referenceMonth)}
                        </p>
                        <Badge className={cn('px-1.5 py-0 text-[10px]', badge.className)}>
                          {badge.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Fecha {formatDateBR(invoice.closingDate)} · vence{' '}
                        {formatDateBR(invoice.dueDate)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold">{formatCurrency(invoice.total)}</p>
                      {invoice.payments > 0 && (
                        <p className="text-xs text-muted-foreground">
                          resta {formatCurrency(Math.max(0, invoice.remaining))}
                        </p>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Pagination
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        summary={`${invoices.length} fatura${invoices.length === 1 ? '' : 's'}`}
      />

      <Dialog
        open={openId !== null}
        onClose={() => setOpenId(null)}
        title={
          detail ? `Fatura de ${invoiceMonthLabel(detail.referenceMonth).toLowerCase()}` : 'Fatura'
        }
      >
        {!detail ? (
          <p className="text-sm text-muted-foreground">Carregando...</p>
        ) : (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">Compras de</dt>
              <dd className="text-right">
                {formatDateBR(detail.periodStart)} a{' '}
                {formatDateBR(
                  new Date(new Date(detail.closingDate).getTime() - 86_400_000).toISOString(),
                )}
              </dd>
              <dt className="text-muted-foreground">Fechamento</dt>
              <dd className="text-right">{formatDateBR(detail.closingDate)}</dd>
              <dt className="text-muted-foreground">Vencimento</dt>
              <dd className="text-right">{formatDateBR(detail.dueDate)}</dd>
              <dt className="text-muted-foreground">Compras</dt>
              <dd className="text-right">{formatCurrency(detail.charges)}</dd>
              {detail.refunds > 0 && (
                <>
                  <dt className="text-muted-foreground">Estornos</dt>
                  <dd className="text-right">−{formatCurrency(detail.refunds)}</dd>
                </>
              )}
              {detail.payments > 0 && (
                <>
                  <dt className="text-muted-foreground">Pagamentos</dt>
                  <dd className="text-right">−{formatCurrency(detail.payments)}</dd>
                </>
              )}
              <dt className="font-medium">{detail.remaining < 0 ? 'Crédito' : 'Restante'}</dt>
              <dd className="text-right font-semibold">
                {formatCurrency(Math.abs(detail.remaining))}
              </dd>
            </dl>

            {paying ? (
              <PayInvoiceForm
                cardId={card.id}
                invoice={detail}
                accounts={resources?.accounts ?? []}
                suggestedAccountId={card.paymentAccountId}
                onSuccess={() => {
                  setPaying(false);
                  reloadAll();
                }}
                onCancel={() => setPaying(false)}
              />
            ) : (
              <Button type="button" size="sm" className="w-full" onClick={() => setPaying(true)}>
                {detail.remaining > 0 ? 'Pagar fatura' : 'Registrar pagamento'}
              </Button>
            )}

            {detail.paymentRecords.length > 0 && (
              <div className="space-y-1">
                <p className="font-medium">Pagamentos</p>
                <ul className="divide-y rounded-md border">
                  {detail.paymentRecords.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 p-2">
                      <div className="min-w-0">
                        <p
                          className={cn(
                            'truncate',
                            p.status === 'reversed' && 'text-muted-foreground line-through',
                          )}
                        >
                          {formatCurrency(p.amount)} · {p.sourceAccount.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateBR(p.paymentDate)}
                          {p.status === 'reversed' && ' · revertido'}
                        </p>
                      </div>
                      {p.status === 'active' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 shrink-0 px-2 text-destructive"
                          onClick={() => void reversePayment(p.id)}
                        >
                          Reverter
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-1">
              <p className="font-medium">Lançamentos</p>
              {detail.items.length === 0 ? (
                <p className="text-muted-foreground">Nenhum lançamento nesta fatura.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {detail.items.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-3 p-2">
                      <div className="min-w-0">
                        <p className="truncate">
                          {item.type === 'refund' && (
                            <Badge variant="outline" className="mr-1 px-1.5 py-0 text-[10px]">
                              Estorno
                            </Badge>
                          )}
                          {item.description}
                          {item.installmentTotal
                            ? ` (${item.installmentNumber}/${item.installmentTotal})`
                            : ''}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {formatDateBR(item.transactionDate)} ·{' '}
                          {item.category?.name ?? 'Sem categoria'}
                        </p>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 font-medium',
                          item.type === 'refund' && 'text-emerald-600',
                        )}
                      >
                        {item.type === 'refund' ? '−' : ''}
                        {formatCurrency(Number(item.amount))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
