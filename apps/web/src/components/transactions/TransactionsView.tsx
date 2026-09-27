'use client';
import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect, useState, Suspense } from 'react';
import {
  ArrowLeftRight,
  CreditCard as CreditCardIcon,
  Eye,
  Plus,
  TrendingDown,
  TrendingUp,
  Undo2,
  Wallet,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import {
  TransactionForm,
  frequencyLabels,
  recurrenceLabels,
} from '@/components/transactions/TransactionForm';
import { useTransactions, type Transaction } from '@/hooks/useTransactions';
import { useTransactionSummary } from '@/hooks/useTransactionSummary';
import { useFinancialResources } from '@/hooks/useFinancialResources';
import { resourceQuery, useResourceFilter } from '@/hooks/useResourceFilter';
import { ResourceFilter } from '@/components/resources/ResourceFilter';
import { DateBasisNote } from '@/components/resources/DateBasisNote';
import { RefundForm } from '@/components/transactions/RefundForm';
import { isEditableEntry, isInflow, signOf, typeLabel } from '@/lib/transaction-display';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { formatDateBR } from '@/lib/utils';
import { cn } from '@/lib/utils';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

const statusLabels: Record<string, string> = {
  confirmed: 'Confirmado',
  cancelled: 'Cancelado',
};
const sourceLabels: Record<string, string> = {
  manual: 'Manual',
  whatsapp: 'WhatsApp',
  ai: 'IA',
  import: 'Importado',
  recurring: 'Recorrente',
};

const typeStyle = {
  income: { icon: TrendingUp, tone: 'text-emerald-600 bg-emerald-50' },
  expense: { icon: TrendingDown, tone: 'text-rose-600 bg-rose-50' },
  refund: { icon: Undo2, tone: 'text-emerald-600 bg-emerald-50' },
} as const;

/** Pagamento de fatura (pernas `transfer`) e transferências antigas. */
const transferStyle = { icon: ArrowLeftRight, tone: 'text-blue-600 bg-blue-50' };

function styleOf(type: string) {
  return typeStyle[type as keyof typeof typeStyle] ?? transferStyle;
}

/**
 * Origens que recebem o selo de destaque: o que foi registrado pela IA. O
 * pipeline do WhatsApp grava `whatsapp`, então checar só `ai` deixava esses
 * lançamentos sem selo.
 */
const REGISTRADO_PELA_IA = new Set<string>(['ai', 'whatsapp']);

function TypeIcon({ tx }: { tx: Transaction }) {
  const style = styleOf(tx.type);
  const Icon = style.icon;
  return (
    <span
      className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', style.tone)}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function EntryBadges({ tx }: { tx: Transaction }) {
  return (
    <>
      {!isEditableEntry(tx) && (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {typeLabel(tx)}
        </Badge>
      )}
      {REGISTRADO_PELA_IA.has(tx.source) && (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          IA
        </Badge>
      )}
      {(tx.recurrenceType === 'parcelado' || tx.recurrenceType === 'fixo') && (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {tx.recurrenceType === 'parcelado' && tx.installmentTotal
            ? `${tx.installmentNumber}/${tx.installmentTotal}`
            : 'Fixo'}
        </Badge>
      )}
    </>
  );
}

function AccountLabel({ tx, className }: { tx: Transaction; className?: string }) {
  if (!tx.account) return <>—</>;
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {tx.account.type === 'credit_card' ? (
        <CreditCardIcon className="h-3.5 w-3.5 shrink-0" aria-label="Cartão" />
      ) : (
        <Wallet className="h-3.5 w-3.5 shrink-0" aria-label="Conta" />
      )}
      <span className="truncate" title={tx.account.name}>
        {tx.account.name}
      </span>
    </span>
  );
}

function amountClass(tx: Transaction) {
  return cn(
    'whitespace-nowrap font-semibold',
    tx.type === 'transfer'
      ? 'text-foreground'
      : isInflow(tx)
        ? 'text-emerald-600'
        : 'text-rose-600',
    tx.status === 'cancelled' && 'text-muted-foreground line-through',
  );
}

function monthLabel(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const label = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const start = `${year}-${String(monthNumber).padStart(2, '0')}-01`;
  const endDate = new Date(Date.UTC(year, monthNumber, 0));
  const end = `${year}-${String(monthNumber).padStart(2, '0')}-${String(
    endDate.getUTCDate(),
  ).padStart(2, '0')}`;
  return { start, end };
}

function TransacoesContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    apiClient
      .get<{ id: string; name: string }[]>('/categories')
      .then(setCategories)
      .catch(() => {
        toast.error('Erro ao carregar categorias');
      });
  }, [toast]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | undefined>();
  const [viewingTx, setViewingTx] = useState<Transaction | undefined>();
  const [refundingTx, setRefundingTx] = useState<Transaction | undefined>();
  const selectedMonth = searchParams.get('month') ?? currentMonth();
  const { start: monthStart, end: monthEnd } = monthRange(selectedMonth);
  const { data: resources } = useFinancialResources();
  const { selection, setSelection } = useResourceFilter();

  const baseFilters = {
    type: searchParams.get('type') ?? undefined,
    status: searchParams.get('status') ?? undefined,
    source: searchParams.get('source') ?? undefined,
    categoryId: searchParams.get('categoryId') ?? undefined,
    search: searchParams.get('search') ?? undefined,
    periodStart: monthStart,
    periodEnd: monthEnd,
    ...resourceQuery(selection),
  };
  const order: 'asc' | 'desc' = searchParams.get('order') === 'asc' ? 'asc' : 'desc';
  const filters = {
    ...baseFilters,
    page: Number(searchParams.get('page') ?? 1),
    limit: 10,
    sortBy: 'transactionDate',
    order,
  };

  const { data, meta, loading, error, refetch } = useTransactions(filters);
  const { data: totals, refetch: refetchTotals } = useTransactionSummary(baseFilters);

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    if (key !== 'page') params.delete('page');
    router.push(`?${params.toString()}`);
  };

  const openNew = () => {
    setEditingTx(undefined);
    setModalOpen(true);
  };
  const openEdit = (tx: Transaction) => {
    setEditingTx(tx);
    setModalOpen(true);
  };
  const openTx = (tx: Transaction) => (isEditableEntry(tx) ? openEdit(tx) : setViewingTx(tx));
  const closeModal = () => setModalOpen(false);
  const handleSuccess = () => {
    closeModal();
    refetchTotals();
    void refetch();
  };
  const handleDelete = async (tx: Transaction) => {
    const ok = await confirm({
      title: 'Excluir lançamento',
      description: `Excluir o lançamento "${tx.description}"? Esta ação não pode ser desfeita.`,
      confirmText: 'Excluir',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/transactions/${tx.id}?hard_delete=true`);
      toast.success('Lançamento excluído.');
      refetchTotals();
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir lançamento');
    }
  };

  // Linha/card inteiro abre o lançamento; os botões não podem propagar o clique.
  const actions = (tx: Transaction) => (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation();
          setViewingTx(tx);
        }}
        title="Ver detalhes"
        aria-label="Ver detalhes"
      >
        <Eye className="h-4 w-4" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive"
        onClick={(e) => {
          e.stopPropagation();
          void handleDelete(tx);
        }}
      >
        Excluir
      </Button>
    </>
  );

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Lançamentos</h1>
          <p className="text-sm text-muted-foreground">Suas receitas e despesas do período.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ResourceFilter resources={resources} value={selection} onChange={setSelection} />
          <Input
            type="month"
            aria-label="Mês dos lançamentos"
            value={selectedMonth}
            onChange={(e) => e.target.value && setParam('month', e.target.value)}
            className="h-9 w-auto text-sm"
          />
          <Button size="sm" onClick={openNew}>
            <Plus className="mr-1 h-4 w-4" />
            Lançamento
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="rounded-2xl">
        <CardContent className="grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
          <Input
            placeholder="Buscar descrição..."
            defaultValue={filters.search}
            onChange={(e) => setParam('search', e.target.value)}
            className="col-span-2 md:col-span-2"
          />
          <Select defaultValue={filters.type} onChange={(e) => setParam('type', e.target.value)}>
            <option value="">Todos os tipos</option>
            <option value="income">Receita</option>
            <option value="expense">Despesa</option>
          </Select>
          <Select
            defaultValue={filters.status}
            onChange={(e) => setParam('status', e.target.value)}
          >
            <option value="">Todos os status</option>
            <option value="confirmed">Confirmado</option>
            <option value="cancelled">Cancelado</option>
          </Select>
          <Select
            defaultValue={filters.categoryId}
            onChange={(e) => setParam('categoryId', e.target.value)}
          >
            <option value="">Todas categorias</option>
            <option value="uncategorized">Sem categoria</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Ordenação por data"
            defaultValue={order}
            onChange={(e) => setParam('order', e.target.value === 'asc' ? 'asc' : '')}
          >
            <option value="desc">Data: mais recentes</option>
            <option value="asc">Data: mais antigas</option>
          </Select>
        </CardContent>
      </Card>

      {totals && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2 sm:gap-4">
            {[
              { label: 'Receitas', value: totals.income, tone: 'text-emerald-600' },
              { label: 'Despesas', value: totals.expense, tone: 'text-rose-600' },
              {
                label: 'Resultado',
                value: totals.net,
                tone: totals.net >= 0 ? 'text-foreground' : 'text-rose-600',
              },
            ].map((item) => (
              <Card key={item.label} className="rounded-2xl">
                <CardContent className="p-3 sm:p-4">
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <p className={cn('truncate text-sm font-bold sm:text-lg', item.tone)}>
                    {formatCurrency(item.value)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
          <DateBasisNote />
        </div>
      )}

      {/* List */}
      <Card className="rounded-2xl">
        <CardContent className="p-0">
          {error ? (
            <div role="alert" className="p-6 text-sm text-destructive">
              {error}
            </div>
          ) : loading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : data.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              Nenhum lançamento encontrado.
            </div>
          ) : (
            <>
              {/* Mobile: um card por lançamento */}
              <ul className="divide-y divide-border md:hidden">
                {data.map((tx) => (
                  <li
                    key={tx.id}
                    onClick={() => openTx(tx)}
                    className="cursor-pointer space-y-2 p-4 transition-colors active:bg-muted/40"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2">
                        <TypeIcon tx={tx} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{tx.description}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {[formatDateBR(tx.transactionDate), tx.category?.name]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        </div>
                      </div>
                      <span className={cn('shrink-0', amountClass(tx))}>
                        {signOf(tx)}
                        {formatCurrency(Number(tx.amount))}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <AccountLabel tx={tx} className="max-w-[9rem]" />
                        <EntryBadges tx={tx} />
                      </div>
                      <div className="-mr-2 flex shrink-0">{actions(tx)}</div>
                    </div>
                  </li>
                ))}
              </ul>

              {/* Tablet/desktop: tabela */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                      <th className="p-3">Descrição</th>
                      <th className="p-3">Categoria</th>
                      <th className="p-3">Conta/Cartão</th>
                      <th className="p-3 text-right">Valor</th>
                      <th className="p-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.map((tx) => (
                      <tr
                        key={tx.id}
                        onClick={() => openTx(tx)}
                        className="cursor-pointer transition-colors hover:bg-muted/40"
                      >
                        <td className="p-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <TypeIcon tx={tx} />
                            <div className="min-w-0">
                              <p className="truncate font-medium">{tx.description}</p>
                              <div className="flex items-center gap-1.5">
                                <p className="text-xs text-muted-foreground">
                                  {formatDateBR(tx.transactionDate)}
                                </p>
                                <EntryBadges tx={tx} />
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap p-3 text-muted-foreground">
                          {tx.category?.name ?? '—'}
                        </td>
                        <td className="p-3 text-muted-foreground">
                          <AccountLabel tx={tx} className="max-w-[12rem]" />
                        </td>
                        <td className={cn('p-3 text-right', amountClass(tx))}>
                          {signOf(tx)}
                          {formatCurrency(Number(tx.amount))}
                        </td>
                        <td className="whitespace-nowrap p-3 text-right">{actions(tx)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {meta.total > 0 && (
        <Pagination
          page={meta.page}
          totalPages={meta.total_pages}
          onPageChange={(nova) => setParam('page', String(nova))}
          summary={`${meta.total} lançamento${meta.total === 1 ? '' : 's'} em ${monthLabel(selectedMonth)}`}
        />
      )}

      {/* Modal */}
      <Dialog
        open={modalOpen}
        onClose={closeModal}
        title={editingTx ? 'Editar lançamento' : 'Novo lançamento'}
      >
        <TransactionForm transaction={editingTx} onSuccess={handleSuccess} onCancel={closeModal} />
        {editingTx && (
          <div className="mt-2 flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => {
                closeModal();
                void handleDelete(editingTx);
              }}
            >
              Excluir lançamento
            </Button>
          </div>
        )}
      </Dialog>

      {/* Detalhes (somente leitura) */}
      <Dialog
        open={!!viewingTx}
        onClose={() => setViewingTx(undefined)}
        title="Detalhes do lançamento"
      >
        {viewingTx && (
          <dl className="space-y-3 text-sm">
            {[
              ['Descrição', viewingTx.description],
              ['Tipo', typeLabel(viewingTx)],
              ['Valor', `${signOf(viewingTx)}${formatCurrency(Number(viewingTx.amount))}`],
              ['Data', formatDateBR(viewingTx.transactionDate)],
              ['Categoria', viewingTx.category?.name ?? '—'],
              ['Conta/cartão', viewingTx.account?.name ?? '—'],
              ['Origem', sourceLabels[viewingTx.source]],
              ['Status', statusLabels[viewingTx.status]],
              [
                'Recorrência',
                viewingTx.recurrenceType === 'parcelado' && viewingTx.installmentTotal
                  ? `Parcelado (${viewingTx.installmentNumber}/${viewingTx.installmentTotal})`
                  : viewingTx.recurrenceType === 'fixo'
                    ? `Fixo · ${frequencyLabels[viewingTx.recurrenceFrequency ?? 'monthly']}`
                    : recurrenceLabels[viewingTx.recurrenceType],
              ],
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex items-center justify-between gap-4 border-b border-border pb-2 last:border-0 last:pb-0"
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {viewingTx?.type === 'transfer' && viewingTx.cardPaymentId && (
          <p className="mt-3 text-xs text-muted-foreground">
            Parte de um pagamento de fatura. Para desfazer, reverta o pagamento na fatura do cartão.
          </p>
        )}
        {viewingTx?.type === 'expense' && viewingTx.status === 'confirmed' && (
          <div className="mt-4 flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setRefundingTx(viewingTx);
                setViewingTx(undefined);
              }}
            >
              <Undo2 className="mr-1 h-4 w-4" />
              Estornar
            </Button>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!refundingTx}
        onClose={() => setRefundingTx(undefined)}
        title="Estornar lançamento"
      >
        {refundingTx && (
          <RefundForm
            transaction={refundingTx}
            onSuccess={() => {
              setRefundingTx(undefined);
              refetchTotals();
              void refetch();
            }}
            onCancel={() => setRefundingTx(undefined)}
          />
        )}
      </Dialog>
    </div>
  );
}

export function TransactionsView() {
  return (
    <Suspense>
      <TransacoesContent />
    </Suspense>
  );
}
