'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  PiggyBank,
  Receipt,
  ArrowUpRight,
  ArrowDownRight,
  Scale,
  CreditCard as CreditCardIcon,
} from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { useFinancialResources } from '@/hooks/useFinancialResources';
import { resourceQuery, useResourceFilter } from '@/hooks/useResourceFilter';
import { ResourceFilter } from '@/components/resources/ResourceFilter';
import { DateBasisNote } from '@/components/resources/DateBasisNote';
import { CategoryDonut } from '@/components/dashboard/CategoryDonut';
import { CategoryBars } from '@/components/dashboard/CategoryBars';
import { ResourceCategoryChart } from '@/components/dashboard/ResourceCategoryChart';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * Item de "Próximas contas a pagar": uma despesa de conta (só a próxima
 * ocorrência de cada série) ou uma fatura de cartão com saldo a pagar.
 */
interface UpcomingBill {
  kind: 'transaction' | 'invoice';
  id: string;
  description: string;
  /** Na fatura, o restante a pagar. */
  amount: number;
  /** Na fatura, o vencimento. */
  transactionDate: string;
  category: { name: string } | null;
  cardId?: string;
  /** `open`: fatura ainda aberta, o valor pode crescer até o fechamento. */
  invoiceState?: 'open' | 'closed';
}

interface DashboardSummary {
  totalBalance: number;
  totalIncome: number;
  totalExpense: number;
  netResult: number;
  expensesByCategory: {
    categoryId: string | null;
    categoryName: string;
    color: string | null;
    total: number;
    percentage: number;
  }[];
  upcomingBills: UpcomingBill[];
  monthlyComparison: { month: string; income: number; expense: number }[];
  /** `YYYY-MM` do último lançamento (pode ser futuro: recorrências e parcelas). */
  lastEntryMonth: string | null;
}

interface DailyBreakdown {
  month: string;
  days: { day: number; income: number; expense: number }[];
}

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

/** Classifica a saúde financeira do mês a partir da taxa de economia (Economia / Receitas). */
function financialHealth(savingsRate: number, hasIncome: boolean) {
  if (!hasIncome) {
    return {
      label: 'Sem dados',
      barClass: 'bg-muted-foreground/30',
      badgeClass: 'bg-muted text-muted-foreground',
    };
  }
  if (savingsRate < 0) {
    return { label: 'Ruim', barClass: 'bg-rose-500', badgeClass: 'bg-rose-100 text-rose-700' };
  }
  if (savingsRate < 10) {
    return {
      label: 'Regular',
      barClass: 'bg-amber-500',
      badgeClass: 'bg-amber-100 text-amber-700',
    };
  }
  if (savingsRate < 20) {
    return { label: 'Bom', barClass: 'bg-blue-500', badgeClass: 'bg-blue-100 text-blue-700' };
  }
  return {
    label: 'Ótimo',
    barClass: 'bg-emerald-500',
    badgeClass: 'bg-emerald-100 text-emerald-700',
  };
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

/** Meses futuros no seletor: no máximo 5 anos, mesmo que haja recorrência mais longa. */
const MAX_FUTURE_MONTHS = 60;

function addMonths(ym: string, n: number) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Opções do seletor: os próximos meses (até o último lançamento agendado) e os anteriores. */
function MonthOptions({ past, future }: { past: string[]; future: string[] }) {
  if (future.length === 0) {
    return (
      <>
        {past.map((m) => (
          <option key={m} value={m}>
            {monthLabelFull(m)}
          </option>
        ))}
      </>
    );
  }
  return (
    <>
      <optgroup label="Próximos meses (previsto)">
        {future.map((m) => (
          <option key={m} value={m}>
            {monthLabelFull(m)}
          </option>
        ))}
      </optgroup>
      <optgroup label="Este mês e anteriores">
        {past.map((m) => (
          <option key={m} value={m}>
            {monthLabelFull(m)}
          </option>
        ))}
      </optgroup>
    </>
  );
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
  if (value === null)
    return <span className="text-xs text-muted-foreground">sem dado anterior</span>;
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
  return (
    <Suspense>
      <DashboardContent />
    </Suspense>
  );
}

function DashboardContent() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const { data: resources } = useFinancialResources();
  const { selection, setSelection } = useResourceFilter();
  const scopeParams = new URLSearchParams(resourceQuery(selection)).toString();

  const [evolutionMonths, setEvolutionMonths] = useState(12);
  const [selectedMonth, setSelectedMonth] = useState('');
  const [daily, setDaily] = useState<DailyBreakdown | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);

  useEffect(() => {
    apiClient
      .get<DashboardSummary>(`/dashboard/summary?${scopeParams}`)
      .then((d) => {
        setData(d);
        setSelectedMonth((current) => current || lastMonthWithMovement(d.monthlyComparison));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
    // Só a primeira carga escolhe o mês; as seguintes seguem o efeito abaixo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedMonth) return;
    const { start, end } = monthRange(selectedMonth);
    setLoading(true);
    apiClient
      .get<DashboardSummary>(
        `/dashboard/summary?period_start=${start}&period_end=${end}&${scopeParams}`,
      )
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedMonth, scopeParams]);

  useEffect(() => {
    if (!selectedMonth) return;
    setDailyLoading(true);
    apiClient
      .get<DailyBreakdown>(`/dashboard/daily?month=${selectedMonth}&${scopeParams}`)
      .then(setDaily)
      .catch(console.error)
      .finally(() => setDailyLoading(false));
  }, [selectedMonth, scopeParams]);

  const evolutionData = useMemo(
    () =>
      (data?.monthlyComparison ?? [])
        .slice(-evolutionMonths)
        .map((m) => ({ ...m, label: monthLabel(m.month) })),
    [data, evolutionMonths],
  );

  // O comparativo mensal termina no mês corrente; depois dele vêm os meses com
  // lançamentos agendados (recorrências e parcelas), para o usuário vê-los.
  const monthOptions = useMemo(() => {
    const past = (data?.monthlyComparison ?? []).map((m) => m.month);
    const current = past[past.length - 1];
    const future: string[] = [];
    if (current && data?.lastEntryMonth && data.lastEntryMonth > current) {
      for (let i = 1; i <= MAX_FUTURE_MONTHS; i++) {
        const month = addMonths(current, i);
        if (month > data.lastEntryMonth) break;
        future.push(month);
      }
    }
    return { past: past.reverse(), future, current };
  }, [data]);
  const isFutureMonth = !!monthOptions.current && selectedMonth > monthOptions.current;

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
          {data.totalIncome > 0
            ? `${savingsRate.toFixed(0)}% da receita`
            : 'sem receita no período'}
        </span>
      ),
    },
  ];

  // Gráficos por contas × cartões: mesmo período da tela e, se houver filtro,
  // só os recursos dele (um tipo fora do filtro mostra o aviso de vazio).
  const { start: periodStart, end: periodEnd } = monthRange(selectedMonth);
  const filterActive = selection.accountIds.length + selection.cardIds.length > 0;
  const chartAccounts =
    resources?.accounts
      .filter((a) => !filterActive || selection.accountIds.includes(a.id))
      .map((a) => ({ id: a.id, name: a.name })) ?? null;
  const chartCards =
    resources?.cards
      .filter((c) => !filterActive || selection.cardIds.includes(c.id))
      .map((c) => ({ id: c.id, name: c.name, archived: !c.isActive })) ?? null;

  const health = financialHealth(savingsRate, data.totalIncome > 0);
  const healthBarWidth = Math.max(0, Math.min(100, ((savingsRate + 20) / 60) * 100));

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Visão geral das suas finanças neste período.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ResourceFilter resources={resources} value={selection} onChange={setSelection} />
          <Select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="h-9 w-auto text-sm"
          >
            <MonthOptions past={monthOptions.past} future={monthOptions.future} />
          </Select>
        </div>
      </div>
      <DateBasisNote />
      {isFutureMonth && (
        <p className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          Mês futuro: receitas, despesas e categorias são previstas pelos lançamentos já agendados
          (recorrências e parcelas). O saldo total é o de hoje.
        </p>
      )}

      {/* Cards de totais */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.label} className="rounded-2xl">
            <CardContent className="space-y-2 p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground sm:text-sm">{card.label}</p>
                <span
                  className={cn('flex h-8 w-8 items-center justify-center rounded-full', card.tone)}
                >
                  <card.icon className="h-4 w-4" />
                </span>
              </div>
              <p className="truncate text-lg font-bold sm:text-2xl">{formatCurrency(card.value)}</p>
              {card.hint}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Saúde financeira */}
      <Card className="rounded-2xl">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-foreground">
                <Scale className="h-4 w-4" />
              </span>
              <CardTitle className="text-base">Saúde Financeira</CardTitle>
            </div>
            <Badge className={health.badgeClass}>{health.label}</Badge>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all', health.barClass)}
              style={{ width: `${healthBarWidth}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {data.totalIncome > 0
              ? isFutureMonth
                ? `Previsão: economia de ${savingsRate.toFixed(0)}% da receita neste mês.`
                : `Você está economizando ${savingsRate.toFixed(0)}% da sua receita neste período.`
              : 'Ainda sem receita registrada neste período para calcular.'}
          </p>
        </CardContent>
      </Card>

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

        <CategoryDonut
          title="Despesas por Categoria"
          subtitle={
            filterActive
              ? 'Contas e cartões do filtro · distribuição do período'
              : 'Contas e cartões · distribuição do período'
          }
          slices={data.expensesByCategory}
        />
      </div>

      {/* Despesas por categoria separadas: contas × cartões */}
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <ResourceCategoryChart
          kind="accounts"
          resources={chartAccounts}
          periodStart={periodStart}
          periodEnd={periodEnd}
          emptyText={filterActive ? 'Nenhuma conta no filtro atual' : 'Nenhuma conta cadastrada'}
        />
        <ResourceCategoryChart
          kind="cards"
          resources={chartCards}
          periodStart={periodStart}
          periodEnd={periodEnd}
          emptyText={filterActive ? 'Nenhum cartão no filtro atual' : 'Nenhum cartão cadastrado'}
        />
      </div>

      {/*
        Mesmos três gráficos em barras horizontais, para comparar com as roscas
        acima (uma das duas versões sai depois).
      */}
      <div className="grid items-start gap-4 sm:gap-6 lg:grid-cols-3">
        <CategoryBars
          title="Despesas por Categoria"
          subtitle={
            filterActive
              ? 'Contas e cartões do filtro · distribuição do período'
              : 'Contas e cartões · distribuição do período'
          }
          slices={data.expensesByCategory}
        />
        <ResourceCategoryChart
          variant="bars"
          kind="accounts"
          resources={chartAccounts}
          periodStart={periodStart}
          periodEnd={periodEnd}
          emptyText={filterActive ? 'Nenhuma conta no filtro atual' : 'Nenhuma conta cadastrada'}
        />
        <ResourceCategoryChart
          variant="bars"
          kind="cards"
          resources={chartCards}
          periodStart={periodStart}
          periodEnd={periodEnd}
          emptyText={filterActive ? 'Nenhum cartão no filtro atual' : 'Nenhum cartão cadastrado'}
        />
      </div>

      {/* Próximas contas a pagar + Lançamentos diários */}
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Card className="rounded-2xl">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">Próximas Contas a Pagar</CardTitle>
            {data.upcomingBills.length > 0 && (
              <Badge variant="secondary">{data.upcomingBills.length} a vencer</Badge>
            )}
          </CardHeader>
          <CardContent>
            {data.upcomingBills.length === 0 ? (
              <div className="flex h-[120px] items-center justify-center text-sm text-muted-foreground">
                Nenhuma conta a vencer 🎉
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {data.upcomingBills.map((bill) => {
                  const overdue = isOverdue(bill.transactionDate);
                  const isInvoice = bill.kind === 'invoice';
                  const Icon = isInvoice ? CreditCardIcon : Receipt;
                  const content = (
                    <>
                      <div className="flex min-w-0 items-center gap-3">
                        <span
                          className={cn(
                            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                            isInvoice
                              ? 'bg-violet-50 text-violet-600'
                              : 'bg-amber-50 text-amber-600',
                          )}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{bill.description}</p>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <span>Vence em {formatDueDate(bill.transactionDate)}</span>
                            {overdue && (
                              <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                                Vencido
                              </Badge>
                            )}
                            {isInvoice && bill.invoiceState === 'open' && (
                              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                                Fatura aberta
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <span className="shrink-0 text-sm font-semibold">
                        {formatCurrency(bill.amount)}
                      </span>
                    </>
                  );
                  return (
                    <li key={`${bill.kind}-${bill.id}`} className="py-3 first:pt-0 last:pb-0">
                      {isInvoice && bill.cardId ? (
                        <Link
                          href={`/app/pessoal/cartoes/${bill.cardId}`}
                          className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 transition-colors hover:bg-muted/40"
                          aria-label={`${bill.description}, ${formatCurrency(bill.amount)}, vence em ${formatDueDate(bill.transactionDate)}`}
                        >
                          {content}
                        </Link>
                      ) : (
                        <div className="flex items-center justify-between gap-3">{content}</div>
                      )}
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
              <MonthOptions past={monthOptions.past} future={monthOptions.future} />
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
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="hsl(var(--border))"
                  />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 10 }}
                    interval={1}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis tick={{ fontSize: 11 }} width={48} axisLine={false} tickLine={false} />
                  <Tooltip
                    formatter={tooltipCurrency}
                    cursor={{ fill: 'hsl(var(--muted))' }}
                    labelFormatter={(d) => `Dia ${d}`}
                  />
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
