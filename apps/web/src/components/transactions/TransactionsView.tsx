'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, Suspense } from 'react';
import {
  AlertTriangle,
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
import { prefetchTransactions, useTransactions, type Transaction } from '@/hooks/useTransactions';
import { useTransactionSummary } from '@/hooks/useTransactionSummary';
import { useFinancialResources } from '@/hooks/useFinancialResources';
import { resourceQuery, useResourceFilter } from '@/hooks/useResourceFilter';
import { ResourceFilter } from '@/components/resources/ResourceFilter';
import { RefundForm } from '@/components/transactions/RefundForm';
import { DeleteInstallmentDialog } from '@/components/transactions/DeleteInstallmentDialog';
import { AdvanceInstallmentDialog } from '@/components/transactions/AdvanceInstallmentDialog';
import { SettlementPanel } from '@/components/transactions/SettlementPanel';
import { TransferForm } from '@/components/transactions/TransferForm';
import {
  canSettle,
  isEditableEntry,
  isInflow,
  isMovement,
  settlementLabel,
  signOf,
  typeLabel,
} from '@/lib/transaction-display';
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

/** Situação do pagamento: pago, a pagar, vencido, parcial, previsto. */
function SettlementBadge({ tx }: { tx: Transaction }) {
  if (tx.status === 'cancelled') return null;
  const info = settlementLabel(tx);
  if (!info) return null;
  return (
    <Badge variant={info.tone} className="px-1.5 py-0 text-[10px]">
      {info.label}
    </Badge>
  );
}

function EntryBadges({ tx }: { tx: Transaction }) {
  return (
    <>
      <SettlementBadge tx={tx} />
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
      {tx.advancedAt && (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          Adiantada
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

/** Quanto falta para vencer, só para datas futuras: "amanhã", "em 5 dias". */
function dueHint(transactionDate: string) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  const days = Math.round(
    (Date.parse(transactionDate.slice(0, 10)) - Date.parse(today)) / 86_400_000,
  );
  if (days === 1) return 'amanhã';
  return days > 1 ? `em ${days} dias` : null;
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
  // Parcela de compra parcelada: a exclusão pergunta o escopo (parcela, futuras, compra).
  const [deletingParcel, setDeletingParcel] = useState<Transaction | undefined>();
  const [advancingSeriesId, setAdvancingSeriesId] = useState<string | undefined>();
  const [transferOpen, setTransferOpen] = useState(false);
  // Atalho "Pagar"/"Receber" da lista: abre direto o registro do pagamento.
  const [settlingTx, setSettlingTx] = useState<Transaction | undefined>();
  // Pagamentos inferidos na migração (entraram no saldo só porque a data chegou).
  const [toReview, setToReview] = useState(0);
  useEffect(() => {
    apiClient
      .get<{ meta: { total: number } }>('/reconciliation/legacy-settlements')
      .then((res) => setToReview(res.meta.total))
      .catch(() => setToReview(0));
  }, []);
  const selectedMonth = searchParams.get('month') ?? currentMonth();
  const { start: monthStart, end: monthEnd } = monthRange(selectedMonth);
  const { data: resources } = useFinancialResources();
  const { selection, setSelection } = useResourceFilter();

  const baseFilters = {
    type: searchParams.get('type') ?? undefined,
    status: searchParams.get('status') ?? undefined,
    source: searchParams.get('source') ?? undefined,
    categoryId: searchParams.get('categoryId') ?? undefined,
    settlement: searchParams.get('settlement') ?? undefined,
    search: searchParams.get('search') ?? undefined,
    periodStart: monthStart,
    periodEnd: monthEnd,
    ...resourceQuery(selection),
  };
  // Abas (docs/adrs/0020): no mês atual, "Até hoje" e "Próximos"; mês passado
  // só tem o que já aconteceu, mês futuro só o que vem por aí.
  const thisMonth = currentMonth();
  const tabs = selectedMonth === thisMonth;
  const timing: 'past' | 'upcoming' =
    selectedMonth < thisMonth
      ? 'past'
      : selectedMonth > thisMonth
        ? 'upcoming'
        : searchParams.get('aba') === 'proximos'
          ? 'upcoming'
          : 'past';
  // "Até hoje": do mais recente para trás; "Próximos": do que vence primeiro.
  const defaultOrder = timing === 'past' ? 'desc' : 'asc';
  const orderParam = searchParams.get('order');
  const order: 'asc' | 'desc' =
    orderParam === 'asc' || orderParam === 'desc' ? orderParam : defaultOrder;
  const filters = {
    ...baseFilters,
    timing,
    page: Number(searchParams.get('page') ?? 1),
    limit: 10,
    sortBy: 'transactionDate',
    order,
  };

  const { data, meta, loading, refreshing, error, refetch } = useTransactions(filters);
  const { data: totals, refetch: refetchTotals } = useTransactionSummary(baseFilters);

  // A primeira página da outra aba fica pronta antes do toque: trocar é instantâneo.
  const otherTab = timing === 'past' ? 'upcoming' : 'past';
  const prefetchKey = tabs && !loading ? JSON.stringify(baseFilters) : null;
  useEffect(() => {
    if (!prefetchKey) return;
    prefetchTransactions({
      ...(JSON.parse(prefetchKey) as typeof baseFilters),
      timing: otherTab,
      page: 1,
      limit: 10,
      sortBy: 'transactionDate',
      order: otherTab === 'past' ? 'desc' : 'asc',
    });
  }, [prefetchKey, otherTab]);

  /**
   * Filtros, aba, ordem e página vivem na URL, mas mudam pelo `history` do
   * navegador (que o Next sincroniza com `useSearchParams`): sem navegação,
   * sem ida ao servidor do Next e sem voltar ao topo — só a lista recarrega.
   * A busca, digitada letra a letra, substitui a entrada em vez de empilhar.
   */
  const setParams = (changes: Record<string, string>, mode: 'push' | 'replace' = 'push') => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    if (!('page' in changes)) params.delete('page');
    const url = `?${params.toString()}`;
    if (mode === 'replace') window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
  };
  const setParam = (key: string, value: string) => setParams({ [key]: value });
  // Trocar de aba volta para a ordem natural dela.
  const setTab = (tab: 'past' | 'upcoming') =>
    setParams({ aba: tab === 'upcoming' ? 'proximos' : '', order: '' });

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
  /** Depois de pagar ou reverter na edição: recarrega a lista e o lançamento editado. */
  const refreshEditing = async () => {
    refetchTotals();
    void refetch();
    if (!editingTx) return;
    try {
      setEditingTx(await apiClient.get<Transaction>(`/transactions/${editingTx.id}`));
    } catch {
      // A lista recarregada já mostra o estado novo.
    }
  };
  /** Depois de pagar ou reverter: recarrega a lista e o lançamento aberto nos detalhes. */
  const refreshViewing = async () => {
    refetchTotals();
    void refetch();
    if (!viewingTx) return;
    try {
      setViewingTx(await apiClient.get<Transaction>(`/transactions/${viewingTx.id}`));
    } catch {
      // A lista recarregada já mostra o estado novo.
    }
  };
  /** Cancela (fica no histórico como cancelado), diferente de excluir. */
  const handleCancelTx = async (tx: Transaction) => {
    const ok = await confirm({
      title: 'Cancelar lançamento',
      description: 'O lançamento ficará com status cancelado. Deseja continuar?',
      confirmText: 'Cancelar lançamento',
      cancelText: 'Voltar',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/transactions/${tx.id}`);
      toast.success('Lançamento cancelado.');
      handleSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao cancelar lançamento');
    }
  };
  const handleDelete = async (tx: Transaction) => {
    if (tx.recurrenceType === 'parcelado' && tx.seriesId) {
      setDeletingParcel(tx);
      return;
    }
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
      {tx.status === 'confirmed' && canSettle(tx) && (
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2"
          onClick={(e) => {
            e.stopPropagation();
            setSettlingTx(tx);
          }}
        >
          {tx.type === 'income' ? 'Receber' : 'Pagar'}
        </Button>
      )}
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
      {!isMovement(tx) && (
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
      )}
    </>
  );

  const reverseTransfer = async (tx: Transaction) => {
    const ok = await confirm({
      title: 'Reverter transferência',
      description:
        'Os saldos das duas contas voltam ao que eram (e os juros/tarifa, se houver, são desfeitos). A transferência fica no histórico como revertida.',
      confirmText: 'Reverter',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.post(`/transfers/${tx.accountTransferId}/reverse`, {});
      toast.success('Transferência revertida.');
      setViewingTx(undefined);
      refetchTotals();
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao reverter transferência');
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Lançamentos</h1>
          <p className="text-sm text-muted-foreground">
            O que entra e o que sai no mês, e o que já foi pago ou recebido.
          </p>
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
          <Button size="sm" variant="outline" onClick={() => setTransferOpen(true)}>
            <ArrowLeftRight className="mr-1 h-4 w-4" />
            Transferir
          </Button>
          <Button size="sm" onClick={openNew}>
            <Plus className="mr-1 h-4 w-4" />
            Lançamento
          </Button>
        </div>
      </div>

      {toReview > 0 && (
        <Link
          href="/app/conta/conciliacao"
          className="flex items-start gap-2 rounded-2xl border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {toReview} pagamento{toReview === 1 ? '' : 's'} entr{toReview === 1 ? 'ou' : 'aram'} no
            saldo só porque a data chegou, sem confirmação. Confira se foram pagos de fato.
          </span>
        </Link>
      )}

      {/* Filters */}
      <Card className="rounded-2xl">
        <CardContent className="grid grid-cols-2 gap-3 p-4 md:grid-cols-7">
          <Input
            placeholder="Buscar descrição..."
            defaultValue={filters.search}
            onChange={(e) => setParams({ search: e.target.value }, 'replace')}
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
            aria-label="Situação do pagamento"
            value={filters.settlement ?? ''}
            onChange={(e) => setParam('settlement', e.target.value)}
          >
            <option value="">Qualquer situação</option>
            <option value="open">Em aberto</option>
            <option value="overdue">Vencidos</option>
            <option value="partial">Pagos em parte</option>
            <option value="settled">Pagos</option>
            <option value="forecast">Previsões</option>
          </Select>
          <Select
            aria-label="Ordenação por data"
            value={order}
            onChange={(e) =>
              setParam('order', e.target.value === defaultOrder ? '' : e.target.value)
            }
          >
            {timing === 'past' ? (
              <>
                <option value="desc">Mais recentes primeiro</option>
                <option value="asc">Mais antigos primeiro</option>
              </>
            ) : (
              <>
                <option value="asc">Vence primeiro</option>
                <option value="desc">Vence por último</option>
              </>
            )}
          </Select>
        </CardContent>
      </Card>

      {totals && (
        <div className="space-y-2">
          {/* Dinheiro que de fato entrou e saiu (docs/adrs/0020). */}
          {/* Celular: um bloco por linha, rótulo à esquerda e valor à direita; a partir do tablet, três colunas. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-4">
            {[
              { label: 'Recebido', value: totals.received, tone: 'text-emerald-600' },
              { label: 'Pago', value: totals.paid, tone: 'text-rose-600' },
              totals.leftover >= 0
                ? { label: 'Sobrou', value: totals.leftover, tone: 'text-foreground' }
                : { label: 'Faltou', value: -totals.leftover, tone: 'text-rose-600' },
            ].map((item) => (
              <Card key={item.label} className="rounded-2xl">
                <CardContent className="flex items-center justify-between gap-3 px-4 py-3 sm:block sm:p-4">
                  <p className="text-sm text-muted-foreground sm:text-xs">{item.label}</p>
                  <p className={cn('truncate text-base font-bold sm:text-lg', item.tone)}>
                    {formatCurrency(item.value)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
          {(totals.toReceive > 0 || totals.toPay > 0 || totals.onCard > 0) && (
            <div className="flex flex-wrap gap-2 text-xs">
              {totals.toReceive > 0 && (
                <span className="rounded-full border bg-background px-2.5 py-1">
                  {formatCurrency(totals.toReceive)} a receber
                </span>
              )}
              {totals.toPay > 0 && (
                <span className="rounded-full border bg-background px-2.5 py-1">
                  {formatCurrency(totals.toPay)} a pagar
                </span>
              )}
              {totals.onCard > 0 && (
                <Link
                  href="/app/pessoal/faturas"
                  className="rounded-full border bg-background px-2.5 py-1 hover:bg-muted"
                >
                  {formatCurrency(totals.onCard)} no cartão — entra em &quot;Pago&quot; quando a
                  fatura for paga
                </Link>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Lançamentos com vencimento em {monthLabel(selectedMonth).toLowerCase()}.
          </p>
        </div>
      )}

      {totals && totals.overdueCount > 0 && filters.settlement !== 'overdue' && (
        <button
          type="button"
          onClick={() => setParams({ settlement: 'overdue', aba: '', order: '' })}
          className="flex w-full items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-left text-sm text-rose-900"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {totals.overdueCount === 1
              ? '1 conta vencida'
              : `${totals.overdueCount} contas vencidas`}{' '}
            e ainda não paga{totals.overdueCount === 1 ? '' : 's'}:{' '}
            {formatCurrency(totals.overdueAmount)}.{' '}
            <span className="font-medium underline">Ver</span>
          </span>
        </button>
      )}
      {filters.settlement === 'overdue' && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border bg-muted/40 p-3 text-sm">
          <span>Mostrando só as contas vencidas e não pagas.</span>
          <Button size="sm" variant="outline" onClick={() => setParam('settlement', '')}>
            Ver todos
          </Button>
        </div>
      )}

      {/* Abas: o que já aconteceu × o que vem até o fim do mês. */}
      {tabs && (
        <div
          role="tablist"
          aria-label="Lançamentos até hoje ou próximos"
          className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/40 p-1 sm:inline-grid"
        >
          {(
            [
              { key: 'past', label: 'Até hoje', count: totals?.pastCount },
              { key: 'upcoming', label: 'Próximos', count: totals?.upcomingCount },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={timing === tab.key}
              onClick={() => timing !== tab.key && setTab(tab.key)}
              className={cn(
                'rounded-md px-4 py-1.5 text-sm transition-colors',
                timing === tab.key
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
              {tab.count !== undefined && ` (${tab.count})`}
            </button>
          ))}
        </div>
      )}

      {/* List: na troca de aba/página, a lista anterior fica esmaecida até a nova chegar. */}
      <Card
        className={cn('rounded-2xl transition-opacity', refreshing && 'opacity-60')}
        aria-busy={refreshing}
      >
        <CardContent className="p-0">
          {error ? (
            <div role="alert" className="p-6 text-sm text-destructive">
              {error}
            </div>
          ) : loading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : data.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              {tabs && timing === 'upcoming'
                ? 'Nada vence até o fim do mês.'
                : 'Nenhum lançamento encontrado.'}
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
                    {/* Conta na linha da data; selos e ações abaixo, com quebra quando não cabem. */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2">
                        <TypeIcon tx={tx} />
                        <div className="min-w-0 space-y-0.5">
                          <p className="truncate font-medium">{tx.description}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {[
                              formatDateBR(tx.transactionDate),
                              dueHint(tx.transactionDate),
                              tx.category?.name,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                          <AccountLabel tx={tx} className="text-xs text-muted-foreground" />
                        </div>
                      </div>
                      <span className={cn('shrink-0', amountClass(tx))}>
                        {signOf(tx)}
                        {formatCurrency(Number(tx.amount))}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-9">
                      <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
                        <EntryBadges tx={tx} />
                      </div>
                      <div className="-mr-2 ml-auto flex shrink-0 items-center">{actions(tx)}</div>
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
                                <p className="whitespace-nowrap text-xs text-muted-foreground">
                                  {formatDateBR(tx.transactionDate)}
                                  {dueHint(tx.transactionDate) &&
                                    ` · ${dueHint(tx.transactionDate)}`}
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
          summary={`${meta.total} lançamento${meta.total === 1 ? '' : 's'} ${
            !tabs
              ? `em ${monthLabel(selectedMonth)}`
              : timing === 'past'
                ? 'até hoje'
                : `até o fim de ${monthLabel(selectedMonth).split(' ')[0].toLowerCase()}`
          }`}
        />
      )}

      {/* Modal */}
      <Dialog
        open={modalOpen}
        onClose={closeModal}
        title={editingTx ? 'Editar lançamento' : 'Novo lançamento'}
      >
        <TransactionForm
          key={editingTx?.id ?? 'novo'}
          transaction={editingTx}
          onSuccess={handleSuccess}
          onCancel={closeModal}
        />
        {editingTx &&
          editingTx.status === 'confirmed' &&
          editingTx.state &&
          ['open', 'partial', 'forecast', 'settled'].includes(editingTx.state) && (
            <SettlementPanel
              key={`${editingTx.id}-${editingTx.settledAmount}`}
              transaction={editingTx}
              accounts={resources?.accounts ?? []}
              onChanged={() => void refreshEditing()}
            />
          )}
        {editingTx && (
          <div className="mt-3 flex flex-wrap justify-end gap-1 border-t pt-3">
            {editingTx.status === 'confirmed' && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => void handleCancelTx(editingTx)}
              >
                Cancelar lançamento
              </Button>
            )}
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
              [
                viewingTx.account?.type === 'credit_card' ? 'Data' : 'Vencimento',
                formatDateBR(viewingTx.transactionDate),
              ],
              ...(viewingTx.eventDate &&
              viewingTx.eventDate.slice(0, 10) !== viewingTx.transactionDate.slice(0, 10)
                ? [
                    [
                      viewingTx.recurrenceType === 'parcelado' ? 'Data da compra' : 'Data do fato',
                      formatDateBR(viewingTx.eventDate),
                    ],
                  ]
                : []),
              ...(settlementLabel(viewingTx) && viewingTx.status !== 'cancelled'
                ? [['Situação', settlementLabel(viewingTx)!.label]]
                : []),
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
              ...(viewingTx.advancedAt
                ? [
                    [
                      'Adiantada em',
                      `${formatDateBR(viewingTx.advancedAt)}${
                        viewingTx.advancedFromDate
                          ? ` (prevista para ${formatDateBR(viewingTx.advancedFromDate)})`
                          : ''
                      }`,
                    ],
                  ]
                : []),
              ...(viewingTx.amountBeforeAdvance != null
                ? [['Valor sem desconto', formatCurrency(Number(viewingTx.amountBeforeAdvance))]]
                : []),
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
        {viewingTx?.type === 'transfer' && viewingTx.accountTransferId && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              Parte de uma transferência entre suas contas: não é receita nem despesa.
            </p>
            {viewingTx.status === 'confirmed' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void reverseTransfer(viewingTx)}
              >
                Reverter transferência
              </Button>
            )}
          </div>
        )}
        {viewingTx?.account?.type === 'credit_card' && viewingTx.type === 'expense' && (
          <p className="mt-3 text-xs text-muted-foreground">
            Compra no cartão não sai do saldo agora: é paga com a fatura.
          </p>
        )}
        {viewingTx &&
          viewingTx.status === 'confirmed' &&
          viewingTx.state &&
          ['open', 'partial', 'forecast', 'settled'].includes(viewingTx.state) && (
            <SettlementPanel
              key={viewingTx.id}
              transaction={viewingTx}
              accounts={resources?.accounts ?? []}
              onChanged={() => void refreshViewing()}
            />
          )}
        {viewingTx?.type === 'expense' && viewingTx.status === 'confirmed' && (
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {viewingTx.recurrenceType === 'parcelado' && viewingTx.seriesId && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setAdvancingSeriesId(viewingTx.seriesId ?? undefined);
                  setViewingTx(undefined);
                }}
              >
                Adiantar parcelas
              </Button>
            )}
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

      <Dialog
        open={!!settlingTx}
        onClose={() => setSettlingTx(undefined)}
        title={settlingTx?.type === 'income' ? 'Registrar recebimento' : 'Registrar pagamento'}
      >
        {settlingTx && (
          <>
            <p className="text-sm">
              <span className="font-medium">{settlingTx.description}</span>
              <span className="text-muted-foreground">
                {' '}
                · vence {formatDateBR(settlingTx.transactionDate)} · falta{' '}
                {formatCurrency(settlingTx.remaining ?? Number(settlingTx.amount))}
              </span>
            </p>
            <SettlementPanel
              key={settlingTx.id}
              transaction={settlingTx}
              accounts={resources?.accounts ?? []}
              startOpen
              onChanged={() => {
                setSettlingTx(undefined);
                refetchTotals();
                void refetch();
              }}
            />
          </>
        )}
      </Dialog>

      <Dialog open={transferOpen} onClose={() => setTransferOpen(false)} title="Transferir">
        {transferOpen && (
          <TransferForm
            accounts={resources?.accounts ?? []}
            onSuccess={() => {
              setTransferOpen(false);
              refetchTotals();
              void refetch();
            }}
            onCancel={() => setTransferOpen(false)}
          />
        )}
      </Dialog>

      <AdvanceInstallmentDialog
        seriesId={advancingSeriesId}
        open={!!advancingSeriesId}
        onClose={() => setAdvancingSeriesId(undefined)}
        onAdvanced={() => {
          setAdvancingSeriesId(undefined);
          refetchTotals();
          void refetch();
        }}
      />

      <DeleteInstallmentDialog
        seriesId={deletingParcel?.seriesId ?? undefined}
        parcel={deletingParcel}
        open={!!deletingParcel}
        onClose={() => setDeletingParcel(undefined)}
        onDeleted={() => {
          setDeletingParcel(undefined);
          refetchTotals();
          void refetch();
        }}
      />
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
