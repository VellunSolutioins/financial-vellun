'use client';
import { useSearchParams, useRouter } from 'next/navigation';
import { useState, Suspense } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { DataTable, type DataTableColumn } from '@/components/ui/table';
import { TransactionForm } from '@/components/transactions/TransactionForm';
import { useTransactions, type Transaction } from '@/hooks/useTransactions';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { formatDateBR } from '@/lib/utils';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

const statusLabels: Record<string, string> = {
  confirmed: 'Confirmado',
  pending: 'Pendente',
  cancelled: 'Cancelado',
};
const sourceLabels: Record<string, string> = {
  manual: 'Manual',
  whatsapp: 'WhatsApp',
  ai: 'IA',
  import: 'Importado',
  recurring: 'Recorrente',
};

/** Origens que recebem o selo de destaque: o que foi registrado pela IA. */
const REGISTRADO_PELA_IA = new Set<string>(['ai', 'whatsapp']);

function monthLabel(month: string) {
  const [year, monthNumber] = month.split('-');
  return `${monthNumber}/${year.slice(2)}`;
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
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | undefined>();
  const selectedMonth = searchParams.get('month') ?? currentMonth();
  const { start: monthStart, end: monthEnd } = monthRange(selectedMonth);

  const monthOptions = Array.from({ length: 12 }, (_, index) => {
    const ref = new Date();
    ref.setMonth(ref.getMonth() - index);
    return `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}`;
  });

  const filters = {
    page: Number(searchParams.get('page') ?? 1),
    limit: 10,
    type: searchParams.get('type') ?? undefined,
    status: searchParams.get('status') ?? undefined,
    source: searchParams.get('source') ?? undefined,
    categoryId: searchParams.get('categoryId') ?? undefined,
    search: searchParams.get('search') ?? undefined,
    periodStart: monthStart,
    periodEnd: monthEnd,
  };

  const { data, meta, loading, refetch } = useTransactions(filters);

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
  const closeModal = () => setModalOpen(false);
  const handleSuccess = () => {
    closeModal();
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
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir lançamento');
    }
  };

  const columns: DataTableColumn<Transaction>[] = [
    {
      key: 'transactionDate',
      header: 'Data',
      cellClassName: 'text-muted-foreground',
      cell: (tx) => formatDateBR(tx.transactionDate),
    },
    {
      key: 'description',
      header: 'Descrição',
      cellClassName: 'font-medium',
      cell: (tx) => tx.description,
    },
    {
      key: 'category',
      header: 'Categoria',
      cellClassName: 'text-muted-foreground',
      cell: (tx) => tx.category?.name ?? '—',
    },
    {
      key: 'account',
      header: 'Conta',
      cellClassName: 'text-muted-foreground',
      cell: (tx) => tx.account?.name ?? '—',
    },
    {
      key: 'source',
      header: 'Origem',
      // Manual não ganha selo: é o caso comum, e um selo em toda linha vira ruído.
      // O destaque é para o que a IA registrou, venha como `ai` ou `whatsapp`: o
      // pipeline do WhatsApp passou a gravar `whatsapp`, e checar só `ai` deixava
      // esses lançamentos com o mesmo selo de uma importação.
      cell: (tx) =>
        tx.source === 'manual' ? null : (
          <Badge variant={REGISTRADO_PELA_IA.has(tx.source) ? 'secondary' : 'outline'}>
            {sourceLabels[tx.source]}
          </Badge>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (tx) => (
        <Badge
          variant={
            tx.status === 'confirmed'
              ? 'success'
              : tx.status === 'pending'
                ? 'warning'
                : 'destructive'
          }
        >
          {statusLabels[tx.status]}
        </Badge>
      ),
    },
    {
      key: 'amount',
      header: 'Valor',
      align: 'right',
      cellClassName: (tx) =>
        `font-semibold ${
          tx.type === 'income'
            ? 'text-green-600'
            : tx.type === 'expense'
              ? 'text-red-600'
              : 'text-gray-700'
        }`,
      cell: (tx) => (
        <>
          {tx.type === 'income' ? '+' : tx.type === 'expense' ? '-' : ''}
          {formatCurrency(Number(tx.amount))}
        </>
      ),
    },
    {
      key: 'acoes',
      align: 'right',
      cellClassName: 'whitespace-nowrap',
      cell: (tx) => (
        <>
          <Button size="sm" variant="ghost" onClick={() => openEdit(tx)}>
            Editar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() => void handleDelete(tx)}
          >
            Excluir
          </Button>
        </>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Lançamentos</h1>
        <div className="flex items-center gap-2">
          <Select
            value={selectedMonth}
            onChange={(e) => setParam('month', e.target.value)}
            className="h-9 w-auto text-sm"
          >
            {monthOptions.map((month) => (
              <option key={month} value={month}>
                {monthLabel(month)}
              </option>
            ))}
          </Select>
          <Button onClick={openNew}>+ Novo lançamento</Button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border p-4 grid grid-cols-2 md:grid-cols-5 gap-3">
        <Input
          placeholder="Buscar descrição..."
          defaultValue={filters.search}
          onChange={(e) => setParam('search', e.target.value)}
        />
        <Select defaultValue={filters.type} onChange={(e) => setParam('type', e.target.value)}>
          <option value="">Todos os tipos</option>
          <option value="income">Receita</option>
          <option value="expense">Despesa</option>
          <option value="transfer">Transferência</option>
        </Select>
        <Select defaultValue={filters.status} onChange={(e) => setParam('status', e.target.value)}>
          <option value="">Todos os status</option>
          <option value="confirmed">Confirmado</option>
          <option value="pending">Pendente</option>
          <option value="cancelled">Cancelado</option>
        </Select>
        <Select
          defaultValue={filters.categoryId}
          onChange={(e) => setParam('categoryId', e.target.value)}
        >
          <option value="">Todas categorias</option>
          <option value="uncategorized">Sem categoria</option>
        </Select>
      </div>

      {/* Table */}
      <DataTable
        columns={columns}
        rows={data}
        rowKey={(tx) => tx.id}
        loading={loading}
        minWidth={720}
        empty="Nenhum lançamento encontrado."
      />

      <Pagination
        page={meta.page}
        totalPages={meta.total_pages}
        onPageChange={(nova) => setParam('page', String(nova))}
        summary={
          meta.total > 0
            ? `${meta.total} lançamento${meta.total === 1 ? '' : 's'} em ${monthLabel(selectedMonth)}`
            : undefined
        }
      />

      {/* Modal */}
      <Dialog
        open={modalOpen}
        onClose={closeModal}
        title={editingTx ? 'Editar lançamento' : 'Novo lançamento'}
      >
        <TransactionForm transaction={editingTx} onSuccess={handleSuccess} onCancel={closeModal} />
      </Dialog>
    </div>
  );
}

export default function LancamentosPage() {
  return (
    <Suspense>
      <TransacoesContent />
    </Suspense>
  );
}
