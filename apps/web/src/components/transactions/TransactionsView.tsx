'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, Suspense } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Plus,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Amount, LedgerRow, PageHeading } from '@/components/dashboard/home-ledger';
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

/** Parcela de compra parcelada: não é excluída nem cancelada sozinha, só a compra. */
function isParcel(tx: Transaction) {
  return tx.recurrenceType === 'parcelado' && !!tx.seriesId;
}

/**
 * Aviso do confirm de excluir/cancelar: a API reverte sozinha o que já foi
 * pago ou recebido, e o saldo da conta acompanha.
 */
function settledNotice(tx: Transaction) {
  const settled = Number(tx.settledAmount ?? 0);
  if (settled <= 0) return '';
  return tx.type === 'income'
    ? ` O recebimento de ${formatCurrency(settled)} será desfeito e o valor sai do saldo da conta.`
    : ` O pagamento de ${formatCurrency(settled)} será desfeito e o valor volta para o saldo da conta.`;
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

/**
 * Origens que recebem o selo de destaque: o que foi registrado pela IA. O
 * pipeline do WhatsApp grava `whatsapp`, então checar só `ai` deixava esses
 * lançamentos sem selo.
 */
const REGISTRADO_PELA_IA = new Set<string>(['ai', 'whatsapp']);

function amountClass(tx: Transaction) {
  return cn(
    'whitespace-nowrap font-semibold',
    tx.type === 'transfer'
      ? 'text-foreground'
      : isInflow(tx)
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-rose-600 dark:text-rose-400',
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

/** "hoje", "ontem", "amanhã" ou "qua, 18/11". */
function dayLabel(day: string) {
  const date = new Date(`${day}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'hoje';
  if (diff === -1) return 'ontem';
  if (diff === 1) return 'amanhã';
  const weekday = date.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  return `${weekday}, ${date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`;
}

/** Agrupa os lançamentos (já ordenados) por dia, com o total líquido de cada dia. */
function groupByDay(items: Transaction[]) {
  const groups: { day: string; label: string; total: number; items: Transaction[] }[] = [];
  for (const tx of items) {
    const day = tx.transactionDate.slice(0, 10);
    let group = groups[groups.length - 1];
    if (!group || group.day !== day) {
      group = { day, label: dayLabel(day), total: 0, items: [] };
      groups.push(group);
    }
    group.items.push(tx);
    if (tx.status !== 'cancelled' && tx.type !== 'transfer') {
      group.total += (isInflow(tx) ? 1 : -1) * Number(tx.amount);
    }
  }
  return groups;
}

/**
 * Um lançamento na lista: inicial da categoria, descrição, uma linha de
 * detalhes (conta, categoria, origem) e o valor; só a ação de pagar/receber
 * aparece na linha. Tocar abre o lançamento.
 */
function TransactionRow({
  tx,
  onOpen,
  action,
}: {
  tx: Transaction;
  onOpen: () => void;
  action: React.ReactNode;
}) {
  const settlement = tx.status === 'cancelled' ? null : settlementLabel(tx);
  const details = [
    tx.account?.name,
    tx.category?.name,
    tx.recurrenceType === 'parcelado' && tx.installmentTotal
      ? `parcela ${tx.installmentNumber}/${tx.installmentTotal}`
      : tx.recurrenceType === 'fixo'
        ? 'fixo'
        : null,
    tx.advancedAt ? 'adiantada' : null,
    !isEditableEntry(tx) ? typeLabel(tx).toLowerCase() : null,
    REGISTRADO_PELA_IA.has(tx.source) ? 'via WhatsApp' : null,
    tx.status === 'cancelled' ? 'cancelado' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const initial = (tx.category?.name ?? tx.description).trim().charAt(0).toUpperCase();
  return (
    <li
      onClick={onOpen}
      className="flex cursor-pointer items-center gap-3 py-3 transition-colors hover:bg-muted/40 active:bg-muted/40"
    >
      <span
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground"
      >
        {tx.type === 'transfer' ? <ArrowLeftRight className="h-4 w-4" /> : initial}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{tx.description}</p>
        <p className="truncate text-xs text-muted-foreground">{details || '—'}</p>
        {settlement && (
          <Badge variant={settlement.tone} className="mt-1 px-1.5 py-0 text-[10px]">
            {settlement.label}
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className={cn('text-sm', amountClass(tx))}>
          {signOf(tx)}
          {formatCurrency(Number(tx.amount))}
        </span>
        {action}
      </div>
    </li>
  );
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
  const [filtersOpen, setFiltersOpen] = useState(false);
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
      description: `O lançamento ficará com status cancelado.${settledNotice(tx)} Deseja continuar?`,
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
    // Parcela não sai sozinha: o diálogo exclui a compra parcelada inteira.
    if (isParcel(tx)) {
      setDeletingParcel(tx);
      return;
    }
    const ok = await confirm({
      title: 'Excluir lançamento',
      description: `Excluir o lançamento "${tx.description}"?${settledNotice(tx)} Esta ação não pode ser desfeita.`,
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

  // Só o que pede ação fica na linha (pagar/receber); ver e excluir ficam no
  // lançamento aberto, para a lista não virar uma fileira de botões.
  const settleAction = (tx: Transaction) =>
    tx.status === 'confirmed' && canSettle(tx) ? (
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-3"
        onClick={(e) => {
          e.stopPropagation();
          setSettlingTx(tx);
        }}
      >
        {tx.type === 'income' ? 'Receber' : 'Pagar'}
      </Button>
    ) : null;

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

  const activeFilters = [
    filters.search,
    filters.type,
    filters.status,
    filters.categoryId,
    filters.settlement,
    order !== defaultOrder ? order : '',
  ].filter(Boolean).length;
  const filtersVisible = filtersOpen || activeFilters > 0;
  const groups = groupByDay(data);

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={
          <>
            <span className="text-primary">lançamentos</span> · {monthLabel(selectedMonth)}
          </>
        }
        title="O que entrou e"
        emphasis="o que saiu"
        actions={
          <>
            <Button variant="outline" onClick={() => setTransferOpen(true)}>
              <ArrowLeftRight className="h-4 w-4" />
              Transferir
            </Button>
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" />
              Lançamento
            </Button>
          </>
        }
      />

      {toReview > 0 && (
        <Link
          href="/app/conta/conciliacao"
          className="flex items-start gap-2 rounded-2xl border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {toReview} pagamento{toReview === 1 ? '' : 's'} entr{toReview === 1 ? 'ou' : 'aram'} no
            saldo só porque a data chegou, sem confirmação. Confira se foram pagos de fato.
          </span>
        </Link>
      )}

      {/* Resumo do mês em linhas de extrato: o dinheiro que de fato entrou e saiu (ADR 0020). */}
      {totals && (
        <section
          aria-label="Resumo do mês"
          className="bg-glow-page space-y-3 rounded-3xl border border-border p-5 shadow-sm sm:p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-xs lowercase tracking-wide text-muted-foreground">
              <span className="text-primary">o mês</span> · pela data de vencimento
            </p>
            <Input
              type="month"
              aria-label="Mês dos lançamentos"
              value={selectedMonth}
              onChange={(e) => e.target.value && setParam('month', e.target.value)}
              className="h-9 w-auto rounded-full text-sm"
            />
          </div>
          <LedgerRow label="Recebido">
            <Amount
              value={totals.received}
              className="text-lg font-bold text-emerald-700 dark:text-emerald-400"
            />
          </LedgerRow>
          <LedgerRow label="Pago">
            <Amount
              value={totals.paid}
              className="text-lg font-bold text-rose-600 dark:text-rose-400"
            />
          </LedgerRow>
          <LedgerRow label={totals.leftover >= 0 ? 'Sobrou' : 'Faltou'}>
            <Amount
              value={Math.abs(totals.leftover)}
              className={cn(
                'text-2xl font-bold',
                totals.leftover < 0 && 'text-rose-600 dark:text-rose-400',
              )}
            />
          </LedgerRow>
          {(totals.toReceive > 0 || totals.toPay > 0 || totals.onCard > 0) && (
            <p className="border-t border-border pt-3 font-mono text-xs text-muted-foreground">
              {[
                totals.toReceive > 0 && `${formatCurrency(totals.toReceive)} a receber`,
                totals.toPay > 0 && `${formatCurrency(totals.toPay)} a pagar`,
              ]
                .filter(Boolean)
                .join(' · ')}
              {totals.onCard > 0 && (
                <>
                  {(totals.toReceive > 0 || totals.toPay > 0) && ' · '}
                  <Link
                    href="/app/pessoal/faturas"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {formatCurrency(totals.onCard)} no cartão
                  </Link>{' '}
                  (entra em &quot;pago&quot; quando a fatura for paga)
                </>
              )}
            </p>
          )}
        </section>
      )}

      {totals && totals.overdueCount > 0 && filters.settlement !== 'overdue' && (
        <button
          type="button"
          onClick={() => setParams({ settlement: 'overdue', aba: '', order: '' })}
          className="flex w-full items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-left text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
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

      {/* Abas, conta/cartão e "Buscar e filtrar" numa linha; os filtros abrem embaixo. */}
      <div className="space-y-3 border-t border-border pt-6">
        <div className="flex flex-wrap items-center gap-2">
          {tabs && (
            <div
              role="tablist"
              aria-label="Lançamentos até hoje ou próximos"
              className="inline-grid grid-cols-2 gap-1 rounded-full border border-border bg-muted/40 p-1"
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
                    'rounded-full px-4 py-1.5 text-sm transition-colors',
                    timing === tab.key
                      ? 'bg-background font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab.label}
                  {tab.count !== undefined && (
                    <span className="ml-1 font-mono text-xs text-muted-foreground">
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <ResourceFilter resources={resources} value={selection} onChange={setSelection} />
          <Button
            variant="outline"
            className="rounded-full"
            aria-expanded={filtersVisible}
            aria-controls="tx-filtros"
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Buscar e filtrar
            {activeFilters > 0 && (
              <span className="rounded-full bg-primary px-1.5 font-mono text-[11px] text-primary-foreground">
                {activeFilters}
              </span>
            )}
          </Button>
        </div>

        {filtersVisible && (
          <div
            id="tx-filtros"
            className="grid grid-cols-2 gap-3 rounded-2xl border bg-card p-4 md:grid-cols-6"
          >
            <Input
              placeholder="Buscar descrição..."
              defaultValue={filters.search}
              onChange={(e) => setParams({ search: e.target.value }, 'replace')}
              className="col-span-2 md:col-span-6"
            />
            <Select
              aria-label="Tipo"
              defaultValue={filters.type}
              onChange={(e) => setParam('type', e.target.value)}
            >
              <option value="">Todos os tipos</option>
              <option value="income">Receita</option>
              <option value="expense">Despesa</option>
            </Select>
            <Select
              aria-label="Status"
              defaultValue={filters.status}
              onChange={(e) => setParam('status', e.target.value)}
            >
              <option value="">Todos os status</option>
              <option value="confirmed">Confirmado</option>
              <option value="cancelled">Cancelado</option>
            </Select>
            <Select
              aria-label="Categoria"
              defaultValue={filters.categoryId}
              onChange={(e) => setParam('categoryId', e.target.value)}
              className="md:col-span-2"
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
          </div>
        )}
      </div>

      {/* Lista agrupada por dia, com o total do dia; na troca de aba/página, a anterior esmaece. */}
      <div className={cn('transition-opacity', refreshing && 'opacity-60')} aria-busy={refreshing}>
        {error ? (
          <div role="alert" className="py-6 text-sm text-destructive">
            {error}
          </div>
        ) : loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">Carregando...</div>
        ) : data.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {tabs && timing === 'upcoming'
              ? 'Nada vence até o fim do mês.'
              : 'Nenhum lançamento encontrado.'}
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.day} aria-label={group.label}>
                <div className="flex items-baseline justify-between gap-3 pb-1">
                  <h2 className="font-mono text-xs lowercase tracking-wide text-muted-foreground">
                    <span className="text-primary">{group.label}</span>
                  </h2>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {group.total > 0 ? '+' : group.total < 0 ? '−' : ''}
                    {formatCurrency(Math.abs(group.total))}
                  </span>
                </div>
                <ul className="divide-y divide-border border-y border-border">
                  {group.items.map((tx) => (
                    <TransactionRow
                      key={tx.id}
                      tx={tx}
                      onOpen={() => openTx(tx)}
                      action={settleAction(tx)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

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
            {editingTx.status === 'confirmed' && !isParcel(editingTx) && (
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
              {isParcel(editingTx) ? 'Excluir compra parcelada' : 'Excluir lançamento'}
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
        {/* Estorno não abre no formulário de edição: excluir fica aqui. */}
        {viewingTx && !isMovement(viewingTx) && !isEditableEntry(viewingTx) && (
          <div className="mt-4 flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => {
                const tx = viewingTx;
                setViewingTx(undefined);
                void handleDelete(tx);
              }}
            >
              Excluir
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
