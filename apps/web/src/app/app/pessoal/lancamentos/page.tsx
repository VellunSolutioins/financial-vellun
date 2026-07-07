'use client';
import { useSearchParams, useRouter } from 'next/navigation';
import { useState, Suspense } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
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
      <div className="bg-white rounded-lg border overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Carregando...</div>
        ) : data.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">Nenhum lançamento encontrado.</div>
        ) : (
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left p-3 font-medium text-muted-foreground">Data</th>
                <th className="text-left p-3 font-medium text-muted-foreground">Descrição</th>
                <th className="text-left p-3 font-medium text-muted-foreground">Categoria</th>
                <th className="text-left p-3 font-medium text-muted-foreground">Conta</th>
                <th className="text-left p-3 font-medium text-muted-foreground">Origem</th>
                <th className="text-left p-3 font-medium text-muted-foreground">Status</th>
                <th className="text-right p-3 font-medium text-muted-foreground">Valor</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((tx) => (
                <tr key={tx.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="p-3 text-muted-foreground">
                    {formatDateBR(tx.transactionDate)}
                  </td>
                  <td className="p-3 font-medium">{tx.description}</td>
                  <td className="p-3 text-muted-foreground">{tx.category?.name ?? '—'}</td>
                  <td className="p-3 text-muted-foreground">{tx.account?.name ?? '—'}</td>
                  <td className="p-3">
                    {tx.source !== 'manual' && (
                      <Badge variant={tx.source === 'ai' ? 'secondary' : 'outline'}>
                        {sourceLabels[tx.source]}
                      </Badge>
                    )}
                  </td>
                  <td className="p-3">
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
                  </td>
                  <td
                    className={`p-3 text-right font-semibold ${
                      tx.type === 'income'
                        ? 'text-green-600'
                        : tx.type === 'expense'
                          ? 'text-red-600'
                          : 'text-gray-700'
                    }`}
                  >
                    {tx.type === 'income' ? '+' : tx.type === 'expense' ? '-' : ''}
                    {formatCurrency(Number(tx.amount))}
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {meta.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {meta.total} lançamento{meta.total === 1 ? '' : 's'} em {monthLabel(selectedMonth)}
          </p>
          {meta.total_pages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={meta.page <= 1}
                onClick={() => setParam('page', String(meta.page - 1))}
              >
                Anterior
              </Button>
              <span className="flex items-center px-3 text-sm text-muted-foreground">
                {meta.page}/{meta.total_pages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={meta.page >= meta.total_pages}
                onClick={() => setParam('page', String(meta.page + 1))}
              >
                Próxima
              </Button>
            </div>
          )}
        </div>
      )}

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
