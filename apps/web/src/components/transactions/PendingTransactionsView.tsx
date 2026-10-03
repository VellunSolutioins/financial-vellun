'use client';
import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { apiClient } from '@/lib/api-client';
import { DataTable, type DataTableColumn } from '@/components/ui/table';
import { useTransactions, type Transaction } from '@/hooks/useTransactions';
import { useFinancialResources } from '@/hooks/useFinancialResources';
import { ResourceSelect } from '@/components/resources/ResourceSelect';
import { formatDateBR } from '@/lib/utils';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

interface Props {
  /** `expense` → contas a pagar; `income` → contas a receber */
  type: 'expense' | 'income';
  title: string;
}

/**
 * Contas a pagar/receber: lançamentos **em aberto** (não pagos, ou pagos em
 * parte), inclusive os vencidos — vencer não paga nada (docs/adrs/0018). Para
 * registrar o pagamento, abra o lançamento em Lançamentos.
 */
export function PendingTransactionsView({ type, title }: Props) {
  const [categories, setCategories] = useState<{ id: string; name: string; type: string }[]>([]);
  const { data: resources } = useFinancialResources();

  // Sem data inicial: o vencido e não pago também aparece.
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState('');

  const filters = useMemo(
    () => ({
      type,
      status: 'confirmed',
      settlement: 'open',
      limit: 500,
      order: 'asc' as const,
      periodStart: periodStart || undefined,
      periodEnd: periodEnd || undefined,
      categoryId: categoryId || undefined,
      accountId: accountId || undefined,
    }),
    [type, periodStart, periodEnd, categoryId, accountId],
  );

  const { data, loading } = useTransactions(filters);

  useEffect(() => {
    apiClient
      .get<{ id: string; name: string; type: string }[]>('/categories')
      .then((cat) => setCategories(cat.filter((c) => c.type === type)))
      .catch(console.error);
  }, [type]);

  const total = data.reduce((sum, t) => sum + Number(t.remaining ?? t.amount), 0);
  const overdueCount = data.filter((t) => t.isOverdue).length;

  const columns: DataTableColumn<Transaction>[] = [
    {
      key: 'transactionDate',
      header: 'Vencimento',
      cellClassName: 'text-muted-foreground',
      cell: (tx) => (
        <span className={tx.isOverdue ? 'font-medium text-red-600' : undefined}>
          {formatDateBR(tx.transactionDate)}
          {tx.isOverdue && ' · vencido'}
        </span>
      ),
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
      header: 'Conta/cartão',
      cellClassName: 'text-muted-foreground',
      cell: (tx) => tx.account?.name ?? '—',
    },
    {
      key: 'amount',
      header: 'Em aberto',
      align: 'right',
      cellClassName: `font-semibold ${type === 'income' ? 'text-green-600' : 'text-red-600'}`,
      cell: (tx) => formatCurrency(Number(tx.remaining ?? tx.amount)),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{title}</h1>

      {/* Total em destaque */}
      <div className="bg-white rounded-lg border p-6">
        <p className="text-sm text-muted-foreground">Total em aberto</p>
        <p
          className={`text-3xl font-bold ${type === 'income' ? 'text-green-600' : 'text-red-600'}`}
        >
          {formatCurrency(total)}
        </p>
        {overdueCount > 0 && (
          <p className="mt-1 text-xs text-red-600">
            {overdueCount} vencido{overdueCount === 1 ? '' : 's'} e ainda não{' '}
            {type === 'income' ? 'recebido' : 'pago'}
            {overdueCount === 1 ? '' : 's'}
          </p>
        )}
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-lg border p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
        <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Todas as categorias</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <ResourceSelect
          aria-label="Conta ou cartão"
          resources={resources}
          purpose="filter"
          emptyLabel="Todas as contas e cartões"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        />
      </div>

      {/* Tabela */}
      <DataTable
        columns={columns}
        rows={data}
        rowKey={(tx) => tx.id}
        loading={loading}
        minWidth={640}
        empty="Nada em aberto no período."
      />
    </div>
  );
}
