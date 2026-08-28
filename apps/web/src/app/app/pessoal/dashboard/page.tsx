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
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  PiggyBank,
  Receipt,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface UpcomingBill {
  id: string;
  description: string;
  amount: number;
  transactionDate: string;
  category: { name: string } | null;
}

interface DashboardSummary {
  totalBalance: number;
  totalIncome: number;
  totalExpense: number;
  netResult: number;
  expensesByCategory: { categoryName: string; total: number; percentage: number }[];
  upcomingBills: UpcomingBill[];
  monthlyComparison: { month: string; income: number; expense: number }[];
}

interface DailyBreakdown {
  month: string;
  days: { day: number; income: number; expense: number }[];
}

const CATEGORY_COLORS = [
  '#10b981',
  '#3b82f6',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#14b8a6',
];

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

/** "2026-06" → "06/26" (usado nos eixos de gráfico, onde o espaço é curto) */
function monthLabel(ym: string) {
  const [y, m] = ym.split('-');
  return `${m}/${y.slice(2)}`;
}

/** "2026-06" → "Junho de 2026" (usado nos seletores de mês) */
function monthLabelFull(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const label = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function tooltipCurrency(v: unknown) {
  return typeof v === 'number' ? formatCurrency(v) : String(v);
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

function lastMonthWithMovement(months: DashboardSummary['monthlyComparison']) {
  const month = [...months].reverse().find((m) => m.income > 0 || m.expense > 0);
  return month?.month ?? months[months.length - 1]?.month ?? '';
}

function formatDueDate(iso: string) {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function isOverdue(iso: string) {
  const due = new Date(`${iso.slice(0, 10)}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Variação de um indicador vs. o mês anterior — verde/vermelho conforme o sentido desejado. */
function TrendBadge({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null) return <span className="text-xs text-muted-foreground">sem dado anterior</span>;
  const isPositive = invert ? value <= 0 : value >= 0;
  const Icon = value >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-medium',
        isPositive ? 'text-emerald-600' : 'text-rose-600',
      )}
    >
      <Icon className="h-3 w-3" />
      {Math.abs(value).toFixed(0)}% vs. mês passado
    </span>
  );
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
        setSelectedMonth(lastMonthWithMovement(d.monthlyComparison));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedMonth) return;
    const { start, end } = monthRange(selectedMonth);
    setLoading(true);
    apiClient
      .get<DashboardSummary>(`/dashboard/summary?period_start=${start}&period_end=${end}`)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedMonth]);

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

  const { incomeChange, expenseChange } = useMemo(() => {
    if (!data) return { incomeChange: null, expenseChange: null };
    const idx = data.monthlyComparison.findIndex((m) => m.month === selectedMonth);
    const current = data.monthlyComparison[idx];
    const previous = idx > 0 ? data.monthlyComparison[idx - 1] : null;
    if (!current || !previous) return { incomeChange: null, expenseChange: null };
    return {
      incomeChange: pctChange(current.income, previous.income),
      expenseChange: pctChange(current.expense, previous.expense),
    };
  }, [data, selectedMonth]);

  if (loading && !data) return <div className="text-muted-foreground">Carregando...</div>;
  if (!data) return <div className="text-destructive">Erro ao carregar dashboard.</div>;

  const savingsRate = data.totalIncome > 0 ? (data.netResult / data.totalIncome) * 100 : 0;

  const cards = [
    {
      label: 'Saldo Total',
      value: data.totalBalance,
      icon: Wallet,
      tone: 'text-blue-600 bg-blue-50',
      hint: <span className="text-xs text-muted-foreground">saldo atual em contas</span>,
    },
    {
      label: 'Receitas',
      value: data.totalIncome,
      icon: TrendingUp,
      tone: 'text-emerald-600 bg-emerald-50',
      hint: <TrendBadge value={incomeChange} />,
    },
    {
      label: 'Despesas',
      value: data.totalExpense,
      icon: TrendingDown,
      tone: 'text-rose-600 bg-rose-50',
      hint: <TrendBadge value={expenseChange} invert />,
    },
    {
      label: 'Economia',
      value: data.netResult,
      icon: PiggyBank,
      tone: 'text-violet-600 bg-violet-50',
      hint: (
        <span className="text-xs text-muted-foreground">
          {data.totalIncome > 0 ? `${savingsRate.toFixed(0)}% da receita` : 'sem receita no período'}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Visão geral das suas finanças neste período.</p>
        </div>
        <Select
          value={selectedMonth}
          onChange={(e) => setSelectedMonth(e.target.value)}
          className="h-9 w-auto text-sm"
        >
          {monthOptions.map((m) => (
            <option key={m} value={m}>
              {monthLabelFull(m)}
            </option>
          ))}
        </Select>
      </div>

      {/* Cards de totais */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.label} className="rounded-2xl">
            <CardContent className="space-y-2 p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground sm:text-sm">{card.label}</p>
                <span className={cn('flex h-8 w-8 items-center justify-center rounded-full', card.tone)}>
                  <card.icon className="h-4 w-4" />
                </span>
              </div>
              <p className="truncate text-lg font-bold sm:text-2xl">{formatCurrency(card.value)}</p>
              {card.hint}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Evolução mensal + Despesas por categoria */}
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Card className="rounded-2xl">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-base">Receitas x Despesas</CardTitle>
              <p className="text-xs text-muted-foreground">Comparativo mensal</p>
            </div>
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
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={evolutionData} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11 }} width={48} axisLine={false} tickLine={false} />
                <Tooltip formatter={tooltipCurrency} cursor={{ fill: 'hsl(var(--muted))' }} />
                <Bar dataKey="income" name="Receitas" fill="#10b981" radius={[6, 6, 0, 0]} />
                <Bar dataKey="expense" name="Despesas" fill="#f43f5e" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-2 flex items-center justify-center gap-6 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#10b981]" /> Receitas
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#f43f5e]" /> Despesas
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-base">Despesas por Categoria</CardTitle>
            <p className="text-xs text-muted-foreground">Distribuição do período</p>
          </CardHeader>
          <CardContent>
            {data.expensesByCategory.length === 0 ? (
              <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
                Sem despesas no período
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 sm:flex-row">
                <ResponsiveContainer width="100%" height={200} className="max-w-[220px]">
                  <PieChart>
                    <Pie
                      data={data.expensesByCategory}
                      dataKey="total"
                      nameKey="categoryName"
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={85}
                      paddingAngle={3}
                      stroke="none"
                    >
                      {data.expensesByCategory.map((_, i) => (
                        <Cell key={i} fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={tooltipCurrency} />
                  </PieChart>
                </ResponsiveContainer>
                <ul className="w-full space-y-2 text-sm sm:w-auto">
                  {data.expensesByCategory.slice(0, 6).map((c, i) => (
                    <li key={c.categoryName} className="flex items-center justify-between gap-4">
                      <span className="flex items-center gap-2 truncate">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }}
                        />
                        <span className="truncate">{c.categoryName}</span>
                      </span>
                      <span className="shrink-0 font-medium text-muted-foreground">
                        {formatCurrency(c.total)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Próximas contas a pagar + Lançamentos diários */}
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Card className="rounded-2xl">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">Próximas Contas a Pagar</CardTitle>
            {data.upcomingBills.length > 0 && (
              <Badge variant="secondary">{data.upcomingBills.length} pendentes</Badge>
            )}
          </CardHeader>
          <CardContent>
            {data.upcomingBills.length === 0 ? (
              <div className="flex h-[120px] items-center justify-center text-sm text-muted-foreground">
                Nenhuma conta pendente 🎉
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {data.upcomingBills.map((bill) => {
                  const overdue = isOverdue(bill.transactionDate);
                  return (
                    <li key={bill.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600">
                          <Receipt className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{bill.description}</p>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span>Vence em {formatDueDate(bill.transactionDate)}</span>
                            {overdue && (
                              <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                                Vencido
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <span className="shrink-0 text-sm font-semibold">{formatCurrency(bill.amount)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">Lançamentos Diários</CardTitle>
            <Select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="h-8 w-auto text-xs"
            >
              {monthOptions.map((m) => (
                <option key={m} value={m}>
                  {monthLabelFull(m)}
                </option>
              ))}
            </Select>
          </CardHeader>
          <CardContent>
            {dailyLoading || !daily ? (
              <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
                Carregando...
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={daily.days} barGap={1}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} interval={1} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11 }} width={48} axisLine={false} tickLine={false} />
                  <Tooltip formatter={tooltipCurrency} cursor={{ fill: 'hsl(var(--muted))' }} labelFormatter={(d) => `Dia ${d}`} />
                  <Bar dataKey="income" name="Receitas" fill="#10b981" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="expense" name="Despesas" fill="#f43f5e" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
