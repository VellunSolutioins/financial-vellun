'use client';
import { useEffect, useMemo, useState } from 'react';
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
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { apiClient } from '@/lib/api-client';

interface DashboardSummary {
  totalBalance: number;
  totalIncome: number;
  totalExpense: number;
  netResult: number;
  expensesByCategory: { categoryName: string; total: number; percentage: number }[];
  monthlyComparison: { month: string; income: number; expense: number }[];
}

interface DailyBreakdown {
  month: string;
  days: { day: number; income: number; expense: number }[];
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

/** "2026-06" → "06/26" */
function monthLabel(ym: string) {
  const [y, m] = ym.split('-');
  return `${m}/${y.slice(2)}`;
}

function tooltipCurrency(v: unknown) {
  return typeof v === 'number' ? formatCurrency(v) : String(v);
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const [evolutionMonths, setEvolutionMonths] = useState(12);
  const [selectedMonth, setSelectedMonth] = useState('');
  const [daily, setDaily] = useState<DailyBreakdown | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);

  useEffect(() => {
    apiClient
      .get<DashboardSummary>('/dashboard/summary')
      .then((d) => {
        setData(d);
        const months = d.monthlyComparison;
        if (months.length > 0) setSelectedMonth(months[months.length - 1].month);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedMonth) return;
    setDailyLoading(true);
    apiClient
      .get<DailyBreakdown>(`/dashboard/daily?month=${selectedMonth}`)
      .then(setDaily)
      .catch(console.error)
      .finally(() => setDailyLoading(false));
  }, [selectedMonth]);

  const evolutionData = useMemo(
    () =>
      (data?.monthlyComparison ?? [])
        .slice(-evolutionMonths)
        .map((m) => ({ ...m, label: monthLabel(m.month) })),
    [data, evolutionMonths],
  );

  const monthOptions = useMemo(
    () => (data?.monthlyComparison ?? []).map((m) => m.month).reverse(),
    [data],
  );

  if (loading) return <div className="text-muted-foreground">Carregando...</div>;
  if (!data) return <div className="text-destructive">Erro ao carregar dashboard.</div>;

  const cards = [
    { label: 'Saldo Total', value: data.totalBalance, color: 'text-blue-600' },
    { label: 'Receitas', value: data.totalIncome, color: 'text-green-600' },
    { label: 'Despesas', value: data.totalExpense, color: 'text-red-600' },
    {
      label: 'Resultado',
      value: data.netResult,
      color: data.netResult >= 0 ? 'text-green-600' : 'text-red-600',
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {/* Cards de totais */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-xl lg:text-2xl font-bold ${card.color}`}>
                {formatCurrency(card.value)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Evolução mensal + Despesas por categoria */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">Evolução Mensal</CardTitle>
            <Select
              value={evolutionMonths}
              onChange={(e) => setEvolutionMonths(Number(e.target.value))}
              className="h-8 w-auto text-xs"
            >
              <option value={6}>6 meses</option>
              <option value={12}>12 meses</option>
            </Select>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={evolutionData} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={48} />
                <Tooltip formatter={tooltipCurrency} />
                <Bar dataKey="income" name="Receitas" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="expense" name="Despesas" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-2 flex items-center justify-center gap-6 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-[#10b981]" /> Receitas
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-[#ef4444]" /> Despesas
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Despesas por Categoria</CardTitle>
          </CardHeader>
          <CardContent>
            {data.expensesByCategory.length === 0 ? (
              <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
                Sem despesas no período
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 sm:flex-row">
                <ResponsiveContainer width="100%" height={220} className="max-w-[240px]">
                  <PieChart>
                    <Pie
                      data={data.expensesByCategory}
                      dataKey="total"
                      nameKey="categoryName"
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={85}
                      paddingAngle={2}
                    >
                      {data.expensesByCategory.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={tooltipCurrency} />
                  </PieChart>
                </ResponsiveContainer>
                <ul className="w-full space-y-2 text-sm sm:w-auto">
                  {data.expensesByCategory.slice(0, 7).map((c, i) => (
                    <li key={c.categoryName} className="flex items-center justify-between gap-4">
                      <span className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 rounded-sm"
                          style={{ backgroundColor: COLORS[i % COLORS.length] }}
                        />
                        {c.categoryName}
                      </span>
                      <span className="font-medium text-muted-foreground">
                        {c.percentage.toFixed(1)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Lançamentos diários do mês */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Lançamentos Diários</CardTitle>
          <Select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="h-8 w-auto text-xs"
          >
            {monthOptions.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </Select>
        </CardHeader>
        <CardContent>
          {dailyLoading || !daily ? (
            <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
              Carregando...
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={daily.days} barGap={1}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} interval={1} />
                <YAxis tick={{ fontSize: 11 }} width={48} />
                <Tooltip
                  formatter={tooltipCurrency}
                  labelFormatter={(d) => `Dia ${d}`}
                />
                <Bar dataKey="income" name="Receitas" fill="#10b981" radius={[2, 2, 0, 0]} />
                <Bar dataKey="expense" name="Despesas" fill="#ef4444" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
