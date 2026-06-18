'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';

interface PendingTransaction {
  id: string;
  description: string;
  amount: number;
  transactionDate: string;
  category?: { name: string } | null;
  account?: { name: string } | null;
}

interface BusinessSummary {
  totalBalance: number;
  totalIncome: number;
  totalExpense: number;
  netResult: number;
  cashFlow: { date: string; income: number; expense: number; balance: number }[];
  topExpenseCategories: { categoryName: string; total: number; percentage: number }[];
  accountsReceivable: { total: number; items: PendingTransaction[] };
  accountsPayable: { total: number; items: PendingTransaction[] };
}

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

function monthRange(date: Date) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

export default function EmpresaDashboardPage() {
  const [data, setData] = useState<BusinessSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));

  useEffect(() => {
    setLoading(true);
    const { start, end } = monthRange(new Date(`${month}-01T00:00:00`));
    apiClient
      .get<BusinessSummary>(`/dashboard/business/summary?period_start=${start}&period_end=${end}`)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [month]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">Dashboard Empresarial</h1>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="border rounded-md px-3 py-2 text-sm"
        />
      </div>

      {loading ? (
        <div className="text-muted-foreground">Carregando...</div>
      ) : !data ? (
        <div className="text-destructive">Erro ao carregar dashboard.</div>
      ) : (
        <>
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
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {card.label}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className={`text-2xl font-bold ${card.color}`}>{formatCurrency(card.value)}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Cash flow */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Fluxo de Caixa</CardTitle>
            </CardHeader>
            <CardContent>
              {data.cashFlow.length === 0 ? (
                <div className="h-[260px] flex items-center justify-center text-muted-foreground text-sm">
                  Sem movimentações confirmadas no período
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={data.cashFlow}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 12 }}
                      tickFormatter={(d: string) => new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                    />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip
                      formatter={(v) => (typeof v === 'number' ? formatCurrency(v) : String(v))}
                      labelFormatter={(d) => new Date(d).toLocaleDateString('pt-BR')}
                    />
                    <Legend />
                    <Area type="monotone" dataKey="income" name="Receitas" stroke="#10b981" fill="#10b981" fillOpacity={0.2} />
                    <Area type="monotone" dataKey="expense" name="Despesas" stroke="#ef4444" fill="#ef4444" fillOpacity={0.2} />
                    <Area type="monotone" dataKey="balance" name="Saldo acumulado" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Payable / Receivable widgets */}
          <div className="grid lg:grid-cols-2 gap-6">
            <PendingWidget
              title="Contas a Receber"
              total={data.accountsReceivable.total}
              items={data.accountsReceivable.items}
              href="/app/empresa/contas-a-receber"
              accent="text-green-600"
            />
            <PendingWidget
              title="Contas a Pagar"
              total={data.accountsPayable.total}
              items={data.accountsPayable.items}
              href="/app/empresa/contas-a-pagar"
              accent="text-red-600"
            />
          </div>

          {/* Top expense categories */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top 5 Categorias de Despesa</CardTitle>
            </CardHeader>
            <CardContent>
              {data.topExpenseCategories.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sem despesas no período.</p>
              ) : (
                <div className="space-y-3">
                  {data.topExpenseCategories.map((c) => (
                    <div key={c.categoryName}>
                      <div className="flex justify-between text-sm mb-1">
                        <span>{c.categoryName}</span>
                        <span className="font-medium">{formatCurrency(c.total)}</span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full bg-red-500" style={{ width: `${c.percentage}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function PendingWidget({
  title,
  total,
  items,
  href,
  accent,
}: {
  title: string;
  total: number;
  items: PendingTransaction[];
  href: string;
  accent: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <Link href={href} className="text-xs text-primary hover:underline">
          Ver todas
        </Link>
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-bold mb-3 ${accent}`}>{formatCurrency(total)}</p>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nada pendente.</p>
        ) : (
          <div className="space-y-2">
            {items.slice(0, 5).map((t) => (
              <div key={t.id} className="flex items-center justify-between py-1 border-b last:border-0">
                <div>
                  <p className="text-sm font-medium">{t.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(t.transactionDate).toLocaleDateString('pt-BR')}
                    {t.category ? ` · ${t.category.name}` : ''}
                  </p>
                </div>
                <span className="text-sm font-semibold">{formatCurrency(t.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
