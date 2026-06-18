'use client';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { apiClient } from '@/lib/api-client';
import { useTransactions } from '@/hooks/useTransactions';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

interface Props {
  /** `expense` → contas a pagar; `income` → contas a receber */
  type: 'expense' | 'income';
  title: string;
  /** Texto do botão de ação, ex.: "Marcar como pago" */
  actionLabel: string;
}

export function PendingTransactionsView({ type, title, actionLabel }: Props) {
  const [categories, setCategories] = useState<{ id: string; name: string; type: string }[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState('');

  const filters = useMemo(
    () => ({
      type,
      status: 'pending',
      limit: 500,
      periodStart: periodStart || undefined,
      periodEnd: periodEnd || undefined,
      categoryId: categoryId || undefined,
      accountId: accountId || undefined,
    }),
    [type, periodStart, periodEnd, categoryId, accountId],
  );

  const { data, loading, refetch } = useTransactions(filters);

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

  const markConfirmed = async (id: string) => {
    setUpdatingId(id);
    try {
      await apiClient.patch(`/transactions/${id}`, { status: 'confirmed' });
      await refetch();
    } catch (e) {
      console.error(e);
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{title}</h1>

      {/* Total em destaque */}
      <div className="bg-white rounded-lg border p-6">
        <p className="text-sm text-muted-foreground">Total pendente</p>
        <p className={`text-3xl font-bold ${type === 'income' ? 'text-green-600' : 'text-red-600'}`}>
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
      <div className="bg-white rounded-lg border overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Carregando...</div>
        ) : data.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">Nada pendente.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left p-3 font-medium text-muted-foreground">Vencimento</th>
                <th className="text-left p-3 font-medium text-muted-foreground">Descrição</th>
                <th className="text-left p-3 font-medium text-muted-foreground">Categoria</th>
                <th className="text-left p-3 font-medium text-muted-foreground">Conta</th>
                <th className="text-right p-3 font-medium text-muted-foreground">Valor</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((tx) => (
                <tr key={tx.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="p-3 text-muted-foreground">
                    {new Date(tx.transactionDate).toLocaleDateString('pt-BR')}
                  </td>
                  <td className="p-3 font-medium">{tx.description}</td>
                  <td className="p-3 text-muted-foreground">{tx.category?.name ?? '—'}</td>
                  <td className="p-3 text-muted-foreground">{tx.account?.name ?? '—'}</td>
                  <td
                    className={`p-3 text-right font-semibold ${type === 'income' ? 'text-green-600' : 'text-red-600'}`}
                  >
                    {formatCurrency(Number(tx.amount))}
                  </td>
                  <td className="p-3 text-right">
                    <Button
                      size="sm"
                      disabled={updatingId === tx.id}
                      onClick={() => markConfirmed(tx.id)}
                    >
                      {updatingId === tx.id ? '...' : actionLabel}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
