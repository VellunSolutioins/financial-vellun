'use client';
import { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Legend,
  type PieLabelRenderProps,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';

interface DashboardSummary {
  totalBalance: number;
  totalIncome: number;
  totalExpense: number;
  netResult: number;
  expensesByCategory: { categoryName: string; total: number; percentage: number }[];
  monthlyComparison: { month: string; income: number; expense: number }[];
  recentTransactions: {
    id: string;
    description: string;
    amount: number;
    type: string;
    transactionDate: string;
  }[];
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

// recharts spreads the data entry into the label render props at runtime
// but the TypeScript type doesn't reflect this, so we cast via PieLabelRenderProps
function renderPieLabel(props: PieLabelRenderProps): string {
  const entry = props as PieLabelRenderProps & { categoryName?: string; percentage?: number };
  const name = entry.categoryName ?? '';
  const pct = entry.percentage ?? 0;
  return `${name} ${Number(pct).toFixed(0)}%`;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<DashboardSummary>('/dashboard/summary')
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-muted-foreground">Carregando...</div>;
  if (!data) return <div className="text-destructive">Erro ao carregar dashboard.</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Saldo Total', value: data.totalBalance, color: 'text-blue-600' },
          { label: 'Receitas', value: data.totalIncome, color: 'text-green-600' },
          { label: 'Despesas', value: data.totalExpense, color: 'text-red-600' },
          {
            label: 'Resultado',
            value: data.netResult,
            color: data.netResult >= 0 ? 'text-green-600' : 'text-red-600',
          },
        ].map((card) => (
          <Card key={card.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{card.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${card.color}`}>{formatCurrency(card.value)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Monthly comparison */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Comparativo Mensal</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.monthlyComparison}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v) => (typeof v === 'number' ? formatCurrency(v) : String(v))} />
                <Legend />
                <Bar dataKey="income" name="Receitas" fill="#10b981" />
                <Bar dataKey="expense" name="Despesas" fill="#ef4444" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Expenses by category */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Despesas por Categoria</CardTitle>
          </CardHeader>
          <CardContent>
            {data.expensesByCategory.length === 0 ? (
              <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">
                Sem despesas no período
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={data.expensesByCategory}
                    dataKey="total"
                    nameKey="categoryName"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={renderPieLabel}
                  >
                    {data.expensesByCategory.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => (typeof v === 'number' ? formatCurrency(v) : String(v))} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent transactions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Últimos Lançamentos</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recentTransactions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum lançamento ainda.</p>
          ) : (
            <div className="space-y-2">
              {data.recentTransactions.map((t) => (
                <div key={t.id} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div>
                    <p className="text-sm font-medium">{t.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(t.transactionDate).toLocaleDateString('pt-BR')}
                    </p>
                  </div>
                  <span
                    className={`font-semibold text-sm ${t.type === 'income' ? 'text-green-600' : 'text-red-600'}`}
                  >
                    {t.type === 'income' ? '+' : '-'}
                    {formatCurrency(t.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
