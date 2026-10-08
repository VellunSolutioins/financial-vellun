'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { CardLimitCard } from '@/components/credit-cards/CardLimitCard';
import { CardSetupForm } from '@/components/credit-cards/CardSetupForm';
import { PayInvoiceForm } from '@/components/credit-cards/PayInvoiceForm';
import {
  formatCurrency,
  invoiceMonthLabel,
  invoiceStatus,
} from '@/components/credit-cards/invoice-labels';
import { useCardInvoices, useInvoiceDetail } from '@/hooks/useCardInvoices';
import {
  useCreditCards,
  type CreditCard,
  type InvoiceItem,
  type InvoicePayment,
} from '@/hooks/useCreditCards';
import { useFinancialResources } from '@/hooks/useFinancialResources';
import { apiClient } from '@/lib/api-client';
import { cn, formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 10;
const LAST_CARD_KEY = 'fv:faturas-cartao';

function readLastCard(): string | null {
  try {
    return window.localStorage.getItem(LAST_CARD_KEY);
  } catch {
    return null;
  }
}

function saveLastCard(cardId: string) {
  try {
    window.localStorage.setItem(LAST_CARD_KEY, cardId);
  } catch {
    // Sem armazenamento (aba privada): só não lembra a escolha.
  }
}

/** Crédito (estorno, crédito anterior) entra negativo; previsão fica fora do total. */
const isCreditItem = (item: InvoiceItem) =>
  item.type === 'refund' || item.type === 'opening_credit';

function itemLabel(item: InvoiceItem) {
  if (item.type === 'opening_debt') return 'Saldo anterior';
  if (item.type === 'opening_credit') return 'Crédito anterior';
  return item.description;
}

function ItemBadges({ item }: { item: InvoiceItem }) {
  return (
    <>
      {item.type === 'refund' && (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          Estorno
        </Badge>
      )}
      {item.isForecast && (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          Prevista
        </Badge>
      )}
      {item.advancedAt && (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          Adiantada
        </Badge>
      )}
    </>
  );
}

function ItemAmount({ item }: { item: InvoiceItem }) {
  return (
    <span
      className={cn(
        'whitespace-nowrap font-medium',
        isCreditItem(item) && 'text-emerald-600',
        item.isForecast && 'text-muted-foreground',
      )}
    >
      {isCreditItem(item) ? '−' : ''}
      {formatCurrency(Number(item.amount))}
    </span>
  );
}

const parcelOf = (item: InvoiceItem) =>
  item.installmentTotal ? `${item.installmentNumber}/${item.installmentTotal}` : '';

/**
 * Linha do extrato da fatura: uma compra (ou estorno, saldo anterior) ou um
 * pagamento. O pagamento entra como linha para a soma bater com o que falta
 * pagar — pago antes do fechamento, a fatura mostra R$ 0,00 e o porquê.
 */
type StatementRow =
  | { kind: 'item'; key: string; item: InvoiceItem }
  | { kind: 'payment'; key: string; payment: InvoicePayment; early: boolean };

const paymentLabel = (row: { early: boolean }) =>
  row.early ? 'Pagamento antecipado' : 'Pagamento da fatura';

function PaymentAmount({ payment }: { payment: InvoicePayment }) {
  return (
    <span className="whitespace-nowrap font-medium text-emerald-600">
      −{formatCurrency(payment.amount)}
    </span>
  );
}

/**
 * Faturas de um cartão (docs/adrs/0020): o limite do cartão escolhido, o total
 * da fatura do mês com a situação e "Marcar como paga", e as compras que a
 * compõem. O mês é o do vencimento; a soma das compras bate com o total.
 */
export function InvoicesView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: activeCards, archived, loading, refetch: refetchCards } = useCreditCards();
  const { data: resources } = useFinancialResources();
  const [settingUp, setSettingUp] = useState<CreditCard | null>(null);
  const [paying, setPaying] = useState(false);
  const [page, setPage] = useState(1);

  // Arquivado só aparece enquanto ainda deve: continua pagável.
  const cards = useMemo(
    () => [...activeCards, ...archived.filter((c) => (c.totalDebt ?? 0) > 0)],
    [activeCards, archived],
  );

  const requestedCard = searchParams.get('cartao');
  const card = useMemo(() => {
    if (cards.length === 0) return null;
    const byId = (id: string | null) => (id ? cards.find((c) => c.id === id) : undefined);
    return (
      byId(requestedCard) ??
      byId(typeof window === 'undefined' ? null : readLastCard()) ??
      cards.find((c) => c.isPreferred) ??
      cards[0]
    );
  }, [cards, requestedCard]);
  const cardId = card && !card.needsSetup ? card.id : null;

  const { data: invoices, refetch: refetchInvoices } = useCardInvoices(cardId);
  const requestedMonth = searchParams.get('mes');
  const index = useMemo(() => {
    if (!invoices || invoices.length === 0) return -1;
    const byMonth = invoices.findIndex((i) => i.referenceMonth === requestedMonth);
    if (byMonth >= 0) return byMonth;
    const current = invoices.findIndex((i) => i.isCurrent);
    return current >= 0 ? current : invoices.length - 1;
  }, [invoices, requestedMonth]);
  const invoice = invoices && index >= 0 ? invoices[index] : null;
  const { data: loadedDetail, refetch: refetchDetail } = useInvoiceDetail(
    cardId,
    invoice?.id ?? null,
  );
  // Ao trocar de fatura, o detalhe anterior não pode aparecer com o cabeçalho novo.
  const detail = loadedDetail && loadedDetail.id === invoice?.id ? loadedDetail : null;

  useEffect(() => setPage(1), [invoice?.id]);
  useEffect(() => {
    if (card) saveLastCard(card.id);
  }, [card]);

  const setParams = (changes: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const reloadAll = () => {
    refetchInvoices();
    refetchDetail();
    void refetchCards();
  };

  const reversePayment = async (paymentId: string) => {
    if (!card || !invoice) return;
    const ok = await confirm({
      title: 'Desfazer pagamento',
      description:
        'O valor volta para a conta de onde saiu e a fatura fica a pagar de novo. O pagamento continua no histórico como desfeito.',
      confirmText: 'Desfazer',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.post(
        `/credit-cards/${card.id}/invoices/${invoice.id}/payments/${paymentId}/reverse`,
        {},
      );
      toast.success('Pagamento desfeito.');
      reloadAll();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao desfazer o pagamento');
    }
  };

  // Conta do pagamento: a do cartão, senão a padrão (se for conta), senão a primeira.
  const accounts = resources?.accounts ?? [];
  const suggestedAccountId =
    card?.paymentAccountId ??
    accounts.find((a) => a.id === resources?.preferredAccountId)?.id ??
    null;

  const otherOverdue = invoices?.find((i) => i.isOverdue && i.id !== invoice?.id) ?? null;

  const items = detail?.items ?? [];
  // Pagamentos ativos entram no extrato, depois das compras; os desfeitos
  // ficam só na lista de pagamentos do card.
  const activePayments = (detail?.paymentRecords ?? []).filter((p) => p.status === 'active');
  const rows: StatementRow[] = [
    ...items.map((item) => ({ kind: 'item' as const, key: item.id, item })),
    ...activePayments.map((payment) => ({
      kind: 'payment' as const,
      key: `pagamento-${payment.id}`,
      payment,
      // Pago antes de a fatura fechar.
      early: !!detail && payment.paymentDate.slice(0, 10) < detail.closingDate.slice(0, 10),
    })),
  ];
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const charged = items.filter((i) => !i.isForecast);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">Faturas</h1>
        <p className="text-sm text-muted-foreground">
          As compras de cada cartão, mês a mês, e o pagamento da fatura.
        </p>
      </div>
      {cards.length > 1 && card && (
        <Select
          aria-label="Cartão"
          value={card.id}
          onChange={(e) => setParams({ cartao: e.target.value, mes: null })}
          className="w-full sm:w-auto"
        >
          {cards.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.isPreferred ? ' ★' : ''}
              {c.isActive ? '' : ' (arquivado)'}
            </option>
          ))}
        </Select>
      )}
    </div>
  );

  if (loading && cards.length === 0) {
    return (
      <div className="space-y-4 sm:space-y-6">
        {header}
        <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
      </div>
    );
  }

  if (!card) {
    return (
      <div className="space-y-4 sm:space-y-6">
        {header}
        <Card className="rounded-2xl">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Nenhum cartão cadastrado ainda.{' '}
            <Link href="/app/pessoal/cartoes" className="font-medium text-foreground underline">
              Cadastrar cartão
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = invoice ? invoiceStatus(invoice) : null;
  // Pagamento antes do fechamento (docs/adrs/0021): só na fatura do ciclo
  // atual. A que ainda não começou só tem parcelas futuras: o caminho é adiantar.
  const notStarted = !!invoice && invoice.isFuture;
  const beforeClosing =
    !!invoice && invoice.state === 'open' && !invoice.isFuture && !invoice.isOpening;
  const paidSoFar = invoice ? invoice.payments : 0;
  const creditsApplied = invoice ? invoice.creditsApplied.reduce((sum, c) => sum + c.amount, 0) : 0;

  return (
    <div className="space-y-4 sm:space-y-6">
      {header}

      {card.needsSetup ? (
        <Card className="rounded-2xl border-amber-200">
          <CardContent className="space-y-3 p-4 text-sm">
            <p>
              Para ver as faturas de <span className="font-medium">{card.name}</span>, informe o dia
              em que a fatura fecha e o dia em que vence.
            </p>
            <Button size="sm" onClick={() => setSettingUp(card)}>
              Configurar fechamento
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {otherOverdue && (
            <button
              type="button"
              onClick={() => setParams({ mes: otherOverdue.referenceMonth })}
              className="flex w-full items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-left text-sm text-rose-900"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Você tem uma fatura vencida (
                {invoiceMonthLabel(otherOverdue.referenceMonth).toLowerCase()}), com{' '}
                {formatCurrency(otherOverdue.remaining)} a pagar.{' '}
                <span className="font-medium underline">Ver</span>
              </span>
            </button>
          )}

          {/* Mês da fatura: navega entre as faturas do cartão. */}
          {invoices && invoices.length > 0 && invoice && (
            <div className="flex items-center justify-between gap-2 rounded-2xl border bg-card p-1">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Fatura anterior"
                disabled={index <= 0}
                onClick={() => setParams({ mes: invoices[index - 1].referenceMonth })}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <p className="min-w-0 truncate text-sm font-medium">
                Fatura de {invoiceMonthLabel(invoice.referenceMonth).toLowerCase()}
              </p>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Próxima fatura"
                disabled={index >= invoices.length - 1}
                onClick={() => setParams({ mes: invoices[index + 1].referenceMonth })}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            {/* Total da fatura: primeiro no celular, é o que a pessoa veio ver. */}
            <Card className="rounded-2xl">
              <CardContent className="space-y-3 p-4 sm:p-5">
                {invoices === null ? (
                  <p className="text-sm text-muted-foreground">Carregando...</p>
                ) : !invoice || !status ? (
                  <p className="text-sm text-muted-foreground">
                    Nenhuma fatura ainda. Ela aparece quando a primeira compra cai no cartão.
                  </p>
                ) : (
                  <>
                    {/* Fatura aberta: o destaque é o que falta pagar agora (zero
                        depois de um pagamento integral antes do fechamento); as
                        compras e o que já foi pago ficam logo abaixo. Fechada: o
                        destaque continua sendo o total da fatura. */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm text-muted-foreground">
                        {beforeClosing ? 'Valor da fatura' : 'Total da fatura'}
                      </span>
                      <Badge className={cn('shrink-0', status.className)}>{status.label}</Badge>
                    </div>
                    <div>
                      <p className="text-2xl font-bold">
                        {formatCurrency(beforeClosing ? invoice.remaining : invoice.total)}
                      </p>
                      <p className="text-xs text-muted-foreground">{status.detail}</p>
                    </div>
                    {(paidSoFar > 0 || creditsApplied > 0) && (
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                        {beforeClosing && (
                          <>
                            <dt className="text-muted-foreground">Compras até agora</dt>
                            <dd className="text-right">{formatCurrency(invoice.total)}</dd>
                          </>
                        )}
                        {paidSoFar > 0 && (
                          <>
                            <dt className="text-muted-foreground">Já pago</dt>
                            <dd className="text-right">−{formatCurrency(paidSoFar)}</dd>
                          </>
                        )}
                        {creditsApplied > 0 && (
                          <>
                            <dt className="text-muted-foreground">Crédito de faturas anteriores</dt>
                            <dd className="text-right">−{formatCurrency(creditsApplied)}</dd>
                          </>
                        )}
                        {!beforeClosing && (
                          <>
                            <dt className="font-medium">Falta pagar</dt>
                            <dd className="text-right font-semibold">
                              {formatCurrency(invoice.remaining)}
                            </dd>
                          </>
                        )}
                      </dl>
                    )}
                    {invoice.unappliedSurplus > 0 && (
                      <p className="text-xs text-emerald-700">
                        Você pagou {formatCurrency(invoice.unappliedSurplus)} a mais: vira crédito
                        na próxima fatura.
                      </p>
                    )}
                    {invoice.forecast > 0 && (
                      <p className="text-xs text-muted-foreground">
                        + {formatCurrency(invoice.forecast)} em assinaturas que ainda vão cair nesta
                        fatura.
                      </p>
                    )}
                    {notStarted ? (
                      invoice.remaining > 0 && (
                        <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
                          Esta fatura ainda não começou. Para pagar estas parcelas agora, adiante-as
                          em{' '}
                          <Link
                            href="/app/pessoal/parcelamentos"
                            className="font-medium text-foreground underline"
                          >
                            Parcelamentos
                          </Link>
                          : elas vêm para a fatura aberta.
                        </p>
                      )
                    ) : beforeClosing ? (
                      invoice.remaining > 0 ? (
                        <div className="space-y-1.5">
                          <Button className="w-full" onClick={() => setPaying(true)}>
                            Pagar
                          </Button>
                          <p className="text-xs text-muted-foreground">
                            Pague tudo ou uma parte agora. O valor pago libera o limite do cartão na
                            hora.
                          </p>
                        </div>
                      ) : (
                        invoice.total > 0 && (
                          <p className="text-xs text-muted-foreground">
                            Tudo o que entrou até agora já está pago.
                          </p>
                        )
                      )
                    ) : (
                      invoice.remaining > 0 && (
                        <Button className="w-full" onClick={() => setPaying(true)}>
                          Marcar como paga
                        </Button>
                      )
                    )}

                    {detail && detail.paymentRecords.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-sm font-medium">Pagamentos</p>
                        <ul className="divide-y rounded-md border text-sm">
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
                                  {p.status === 'reversed' && ' · desfeito'}
                                </p>
                              </div>
                              {p.status === 'active' && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 shrink-0 px-2 text-destructive"
                                  onClick={() => void reversePayment(p.id)}
                                >
                                  Desfazer
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            <CardLimitCard card={card} />
          </div>

          {invoice && (
            <Card className="rounded-2xl">
              <CardContent className="p-0">
                {!detail ? (
                  <div className="p-10 text-center text-sm text-muted-foreground">
                    Carregando...
                  </div>
                ) : rows.length === 0 ? (
                  <div className="p-10 text-center text-sm text-muted-foreground">
                    Nenhuma compra nesta fatura.
                  </div>
                ) : (
                  <>
                    {/* Mobile: uma linha por compra ou pagamento */}
                    <ul className="divide-y divide-border md:hidden">
                      {pageRows.map((row) =>
                        row.kind === 'payment' ? (
                          <li key={row.key} className="flex items-start justify-between gap-3 p-4">
                            <div className="min-w-0 space-y-0.5">
                              <p className="truncate font-medium">{paymentLabel(row)}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {formatDateBR(row.payment.paymentDate)} ·{' '}
                                {row.payment.sourceAccount.name}
                              </p>
                            </div>
                            <PaymentAmount payment={row.payment} />
                          </li>
                        ) : (
                          <li key={row.key} className="flex items-start justify-between gap-3 p-4">
                            <div className="min-w-0 space-y-0.5">
                              <p className="truncate font-medium">
                                {itemLabel(row.item)}
                                {parcelOf(row.item) && (
                                  <span className="font-normal text-muted-foreground">
                                    {' '}
                                    · {parcelOf(row.item)}
                                  </span>
                                )}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {formatDateBR(row.item.transactionDate)} ·{' '}
                                {row.item.category?.name ?? 'Sem categoria'}
                              </p>
                              <div className="flex flex-wrap gap-1">
                                <ItemBadges item={row.item} />
                              </div>
                            </div>
                            <ItemAmount item={row.item} />
                          </li>
                        ),
                      )}
                    </ul>

                    {/* Tablet/desktop: tabela */}
                    <div className="hidden overflow-x-auto md:block">
                      <table className="w-full min-w-[640px] text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                            <th className="p-3">Data</th>
                            <th className="p-3">Descrição</th>
                            <th className="p-3">Categoria</th>
                            <th className="p-3">Parcela</th>
                            <th className="p-3 text-right">Valor</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {pageRows.map((row) =>
                            row.kind === 'payment' ? (
                              <tr key={row.key} className="bg-emerald-50/40 hover:bg-emerald-50">
                                <td className="whitespace-nowrap p-3 text-muted-foreground">
                                  {formatDateBR(row.payment.paymentDate)}
                                </td>
                                <td className="p-3 font-medium">{paymentLabel(row)}</td>
                                <td className="p-3 text-muted-foreground">
                                  {row.payment.sourceAccount.name}
                                </td>
                                <td className="p-3 text-muted-foreground">—</td>
                                <td className="p-3 text-right">
                                  <PaymentAmount payment={row.payment} />
                                </td>
                              </tr>
                            ) : (
                              <tr key={row.key} className="hover:bg-muted/40">
                                <td className="whitespace-nowrap p-3 text-muted-foreground">
                                  {formatDateBR(row.item.transactionDate)}
                                </td>
                                <td className="p-3">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-medium">{itemLabel(row.item)}</span>
                                    <ItemBadges item={row.item} />
                                  </div>
                                </td>
                                <td className="p-3 text-muted-foreground">
                                  {row.item.category?.name ?? 'Sem categoria'}
                                </td>
                                <td className="p-3 text-muted-foreground">
                                  {parcelOf(row.item) || '—'}
                                </td>
                                <td className="p-3 text-right">
                                  <ItemAmount item={row.item} />
                                </td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {detail && rows.length > 0 && (
            <Pagination
              page={currentPage}
              totalPages={totalPages}
              onPageChange={setPage}
              summary={
                `${charged.length} lançamento${charged.length === 1 ? '' : 's'} · total ${formatCurrency(detail.total)}` +
                (detail.payments > 0
                  ? ` · pago ${formatCurrency(detail.payments)} · falta pagar ${formatCurrency(detail.remaining)}`
                  : '')
              }
            />
          )}
        </>
      )}

      <Dialog
        open={paying}
        onClose={() => setPaying(false)}
        title={beforeClosing ? 'Pagar antes do fechamento' : 'Marcar fatura como paga'}
      >
        {paying && invoice && (
          <PayInvoiceForm
            cardId={card.id}
            invoice={invoice}
            accounts={accounts}
            suggestedAccountId={suggestedAccountId}
            onSuccess={() => {
              setPaying(false);
              reloadAll();
            }}
            onCancel={() => setPaying(false)}
          />
        )}
      </Dialog>

      <Dialog
        open={settingUp !== null}
        onClose={() => setSettingUp(null)}
        title="Configurar fechamento"
      >
        {settingUp && (
          <CardSetupForm
            card={settingUp}
            onSuccess={() => {
              setSettingUp(null);
              void refetchCards();
            }}
            onCancel={() => setSettingUp(null)}
          />
        )}
      </Dialog>
    </div>
  );
}
