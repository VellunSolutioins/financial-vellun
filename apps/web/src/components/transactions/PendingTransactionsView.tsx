'use client';
import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { apiClient } from '@/lib/api-client';
import { DataTable, type DataTableColumn } from '@/components/ui/table';
import { useTransactions, type Transaction } from '@/hooks/useTransactions';
import { formatDateBR } from '@/lib/utils';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

interface Props {
  /** `expense` → contas a pagar; `income` → contas a receber */
  type: 'expense' | 'income';
  title: string;
}

function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Contas a pagar/receber: lançamentos com data de hoje em diante. Não existe
 * status pendente — o que ainda vai acontecer é definido pela data.
 */
export function PendingTransactionsView({ type, title }: Props) {
  const [categories, setCategories] = useState<{ id: string; name: string; type: string }[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);

  const [periodStart, setPeriodStart] = useState(todayLocal);
  const [periodEnd, setPeriodEnd] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState('');

  const filters = useMemo(
    () => ({
      type,
      status: 'confirmed',
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
    Promise.all([
      apiClient.get<{ id: string; name: string; type: string }[]>('/categories'),
      apiClient.get<{ id: string; name: string }[]>('/accounts'),
    ])
      .then(([cat, acc]) => {
        setCategories(cat.filter((c) => c.type === type));
        setAccounts(acc);
      })
      .catch(console.error);
  }, [type]);

  const total = data.reduce((sum, t) => sum + Number(t.amount), 0);

  const columns: DataTableColumn<Transaction>[] = [
    {
      key: 'transactionDate',
      header: 'Vencimento',
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
      key: 'amount',
      header: 'Valor',
      align: 'right',
      cellClassName: `font-semibold ${type === 'income' ? 'text-green-600' : 'text-red-600'}`,
      cell: (tx) => formatCurrency(Number(tx.amount)),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{title}</h1>

      {/* Total em destaque */}
      <div className="bg-white rounded-lg border p-6">
        <p className="text-sm text-muted-foreground">Total a vencer</p>
        <p
          className={`text-3xl font-bold ${type === 'income' ? 'text-green-600' : 'text-red-600'}`}
        >
          {formatCurrency(total)}
        </p>
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
        <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Todas as contas</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>

      {/* Tabela */}
      <DataTable
        columns={columns}
        rows={data}
        rowKey={(tx) => tx.id}
        loading={loading}
        minWidth={640}
        empty="Nada a vencer no período."
      />
    </div>
  );
}
