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
  CalendarClock,
  ArrowLeftRight,
} from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { useFinancialResources } from '@/hooks/useFinancialResources';
import { resourceQuery, useResourceFilter } from '@/hooks/useResourceFilter';
import { ResourceFilter } from '@/components/resources/ResourceFilter';
import { DateBasisNote } from '@/components/resources/DateBasisNote';
import { CategoryBars } from '@/components/dashboard/CategoryBars';
import { ResourceCategoryChart } from '@/components/dashboard/ResourceCategoryChart';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * Item de "Contas a pagar": uma despesa de conta em aberto (só a mais antiga
 * de cada série, inclusive vencida) ou uma fatura com restante conciliado.
 */
interface UpcomingBill {
  kind: 'transaction' | 'invoice';
  id: string;
  description: string;
  amount: number;
  /** O que falta pagar. */
  remaining: number;
  /** Vencimento (na fatura, o dela). */
  transactionDate: string;
  isOverdue: boolean;
  category: { name: string } | null;
  cardId?: string;
  /** `open`: fatura ainda aberta, o valor pode crescer até o fechamento. */
  invoiceState?: 'open' | 'closed';
}

/** Indicadores do dashboard pessoal (docs/adrs/0018): cada um com nome, fórmula e base. */
interface DashboardSummary {
  /** Saldo atual das contas de caixa; nulo quando o filtro não tem conta (só cartão). */
  cashBalance: number | null;
  investmentsBalance: number;
  loansDebt: number;
  /** Gastos pela data da compra: realizados e previstos no período. */
  spending: {
    realized: number;
    forecast: number;
    byNature: { consumption: number; asset_acquisition: number; financial_cost: number };
  };
  /** Receitas: recebidas e a receber no período. */
  income: { received: number; pending: number };
  /** Receitas recebidas − gastos realizados. */
  result: { value: number; percentOfIncome: number | null };
  cashFlow: {
    inflow: number;
    outflow: number;
    invoicePayments: number;
    transfersNet: number;
    net: number;
  };
  commitments: {
    horizon: string;
    overdueBills: number;
    overdueForecast: number;
    billsToHorizon: number;
    forecastToHorizon: number;
    receivableToHorizon: number;
    invoicesOverdue: number;
    invoicesToHorizon: number;
  };
  cards: {
    totalDebt: number;
    overdue: number;
    futureInstallments: number;
    creditBalance: number;
    forecast: number;
    incompleteCards: number;
    cardCount: number;
  } | null;
  projected: {
    horizon: string;
    value: number;
    components: {
      cashBalance: number;
      receivable: number;
      overdueBills: number;
      bills: number;
      forecastBills: number;
      invoices: number;
    };
  } | null;
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

/** Classifica a saúde do mês pelo resultado ÷ receitas recebidas. */
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

  const savingsRate = data.result.percentOfIncome ?? 0;
  const hasIncome = data.income.received > 0;
  const horizonLabel = formatDueDate(data.commitments.horizon);

  // Com o filtro só em cartões, saldo bancário não é medida daquele recurso:
  // o primeiro número vira a dívida do cartão.
  const firstCard =
    data.cashBalance === null && data.cards
      ? {
          label: 'Dívida no cartão',
          value: data.cards.totalDebt,
          icon: CreditCardIcon,
          tone: 'text-violet-600 bg-violet-50',
          hint: (
            <span className="text-xs text-muted-foreground">
              efetiva hoje, depois de pagamentos e créditos
            </span>
          ),
        }
      : {
          label: 'Saldo atual em contas',
          value: data.cashBalance ?? 0,
          icon: Wallet,
          tone: 'text-blue-600 bg-blue-50',
          hint: (
            <span className="text-xs text-muted-foreground">
              hoje · sem investimentos nem cartões
            </span>
          ),
        };

  const cards = [
    firstCard,
    {
      label: 'Receitas recebidas',
      value: data.income.received,
      icon: TrendingUp,
      tone: 'text-emerald-600 bg-emerald-50',
      hint: (
        <div className="space-y-0.5">
          <TrendBadge value={incomeChange} />
          {data.income.pending > 0 && (
            <p className="text-xs text-muted-foreground">
              a receber: {formatCurrency(data.income.pending)}
            </p>
          )}
        </div>
      ),
    },
    {
      label: 'Gastos por data da compra',
      value: data.spending.realized,
      icon: TrendingDown,
      tone: 'text-rose-600 bg-rose-50',
      hint: (
        <div className="space-y-0.5">
          <TrendBadge value={expenseChange} invert />
          {data.spending.forecast > 0 && (
            <p className="text-xs text-muted-foreground">
              previstos: {formatCurrency(data.spending.forecast)}
            </p>
          )}
        </div>
      ),
    },
    {
      label: 'Resultado do período',
      value: data.result.value,
      icon: PiggyBank,
      tone: 'text-violet-600 bg-violet-50',
      hint: (
        <span className="text-xs text-muted-foreground">
          {hasIncome
            ? `${savingsRate.toFixed(0)}% das receitas recebidas`
            : 'recebidas − gastos; sem receita recebida'}
        </span>
      ),
    },
  ];

  const overdueTotal = data.commitments.overdueBills + data.commitments.invoicesOverdue;
  const dueTotal = data.commitments.billsToHorizon + data.commitments.invoicesToHorizon;

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

  const health = financialHealth(savingsRate, hasIncome);
  const healthBarWidth = Math.max(0, Math.min(100, ((savingsRate + 20) / 60) * 100));

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            O que entrou, o que foi gasto e o que ainda vence.
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
      <DateBasisNote variant="purchase" />
      {isFutureMonth && (
        <p className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          Mês futuro: nada foi realizado ainda. Veja os valores previstos em cada indicador; o saldo
          em contas é o de hoje.
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

      {/* Compromissos, cartões e projeção — por vencimento, a partir de hoje */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
        <Card className="rounded-2xl">
          <CardContent className="space-y-1 p-4">
            <p className="text-xs font-medium text-muted-foreground">Vencidas e não pagas</p>
            <p className={cn('text-lg font-bold', overdueTotal > 0 ? 'text-rose-600' : undefined)}>
              {formatCurrency(overdueTotal)}
            </p>
            <p className="text-xs text-muted-foreground">
              contas {formatCurrency(data.commitments.overdueBills)} · faturas{' '}
              {formatCurrency(data.commitments.invoicesOverdue)}
            </p>
            {data.commitments.overdueForecast > 0 && (
              <p className="text-xs text-amber-700">
                + {formatCurrency(data.commitments.overdueForecast)} em previsões vencidas: confirme
                ou cancele
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="space-y-1 p-4">
            <p className="text-xs font-medium text-muted-foreground">A vencer até {horizonLabel}</p>
            <p className="text-lg font-bold">{formatCurrency(dueTotal)}</p>
            <p className="text-xs text-muted-foreground">
              contas {formatCurrency(data.commitments.billsToHorizon)} · faturas{' '}
              {formatCurrency(data.commitments.invoicesToHorizon)}
            </p>
            {data.commitments.forecastToHorizon > 0 && (
              <p className="text-xs text-muted-foreground">
                previsto: {formatCurrency(data.commitments.forecastToHorizon)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="space-y-1 p-4">
            <p className="text-xs font-medium text-muted-foreground">Dívida efetiva no cartão</p>
            {data.cards ? (
              <>
                <p className="text-lg font-bold">{formatCurrency(data.cards.totalDebt)}</p>
                <p className="text-xs text-muted-foreground">
                  parcelas futuras a pagar {formatCurrency(data.cards.futureInstallments)}
                </p>
                {data.cards.creditBalance > 0 && (
                  <p className="text-xs text-emerald-700">
                    saldo credor {formatCurrency(data.cards.creditBalance)}
                  </p>
                )}
                {data.cards.forecast > 0 && (
                  <p className="text-xs text-muted-foreground">
                    assinaturas/compras previstas {formatCurrency(data.cards.forecast)} (fora da
                    dívida)
                  </p>
                )}
                {data.cards.incompleteCards > 0 && (
                  <p className="text-xs text-amber-700">
                    {data.cards.incompleteCards} cartão(ões) sem configuração: dívida desconhecida
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Nenhum cartão no filtro.</p>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="space-y-1 p-4">
            <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" />
              Saldo projetado até {horizonLabel}
            </p>
            {data.projected ? (
              <>
                <p
                  className={cn(
                    'text-lg font-bold',
                    data.projected.value < 0 ? 'text-rose-600' : undefined,
                  )}
                >
                  {formatCurrency(data.projected.value)}
                </p>
                <p className="text-xs text-muted-foreground">
                  saldo em contas + a receber (
                  {formatCurrency(data.projected.components.receivable)}) − contas vencidas e a
                  vencer, previsões e faturas até {horizonLabel}. Não é saldo bancário nem
                  patrimônio.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Sem conta no filtro.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Fluxo de caixa realizado e outras posições */}
      <Card className="rounded-2xl">
        <CardContent className="space-y-2 p-4 sm:p-5">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-foreground">
              <ArrowLeftRight className="h-4 w-4" />
            </span>
            <div>
              <CardTitle className="text-base">Fluxo de caixa realizado</CardTitle>
              <p className="text-xs text-muted-foreground">
                O que de fato entrou e saiu das contas no período, pela data do pagamento.
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            {[
              ['Entradas', data.cashFlow.inflow],
              ['Pagamentos', -data.cashFlow.outflow],
              ['Faturas pagas', -data.cashFlow.invoicePayments],
              ['Aportes, resgates e empréstimos', data.cashFlow.transfersNet],
              ['Variação do caixa', data.cashFlow.net],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-lg bg-muted/40 p-2">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-semibold">{formatCurrency(value as number)}</dd>
              </div>
            ))}
          </dl>
          {(data.investmentsBalance !== 0 || data.loansDebt > 0) && (
            <p className="text-xs text-muted-foreground">
              Fora do saldo em contas: investimentos {formatCurrency(data.investmentsBalance)} ·
              empréstimos a pagar {formatCurrency(data.loansDebt)}.
            </p>
          )}
          {(data.spending.byNature.asset_acquisition > 0 ||
            data.spending.byNature.financial_cost > 0) && (
            <p className="text-xs text-muted-foreground">
              Nos gastos do período: aquisição de bens{' '}
              {formatCurrency(data.spending.byNature.asset_acquisition)} · juros e tarifas{' '}
              {formatCurrency(data.spending.byNature.financial_cost)}.
            </p>
          )}
        </CardContent>
      </Card>

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
            {hasIncome
              ? `O resultado do período (receitas recebidas − gastos por data da compra) é ${savingsRate.toFixed(0)}% das receitas recebidas.`
              : 'Ainda sem receita recebida neste período para calcular.'}
          </p>
        </CardContent>
      </Card>

      {/* Despesas por categoria: consolidado, contas e cartões */}
      <div className="grid items-start gap-4 sm:gap-6 lg:grid-cols-3">
        <CategoryBars
          title={'Para onde foi\nseu dinheiro'}
          subtitle={
            filterActive
              ? 'Gastos realizados do filtro · data da compra'
              : 'Gastos realizados · data da compra'
          }
          slices={data.expensesByCategory}
        />
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

      {/* Evolução mensal + Lançamentos diários */}
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Card className="rounded-2xl">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-base">Receitas x Gastos</CardTitle>
              <p className="text-xs text-muted-foreground">
                Recebidas e gastos pela data da compra, por mês
              </p>
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
                <Bar dataKey="expense" name="Gastos" fill="#f43f5e" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-2 flex items-center justify-center gap-6 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#10b981]" /> Receitas recebidas
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#f43f5e]" /> Gastos
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">Gastos e receitas por dia</CardTitle>
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
                  <Bar dataKey="expense" name="Gastos" fill="#f43f5e" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Próximas contas a pagar */}
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">Contas a pagar</CardTitle>
            <p className="text-xs text-muted-foreground">
              Em aberto, vencidas primeiro — vencer não paga nada
            </p>
          </div>
          {data.upcomingBills.length > 0 && (
            <Badge variant="secondary">{data.upcomingBills.length} em aberto</Badge>
          )}
        </CardHeader>
        <CardContent>
          {data.upcomingBills.length === 0 ? (
            <div className="flex h-[120px] items-center justify-center text-sm text-muted-foreground">
              Nenhuma conta em aberto 🎉
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.upcomingBills.map((bill) => {
                const overdue = bill.isOverdue;
                const isInvoice = bill.kind === 'invoice';
                const Icon = isInvoice ? CreditCardIcon : Receipt;
                const content = (
                  <>
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className={cn(
                          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                          isInvoice ? 'bg-violet-50 text-violet-600' : 'bg-amber-50 text-amber-600',
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
                      {formatCurrency(bill.remaining)}
                    </span>
                  </>
                );
                return (
                  <li key={`${bill.kind}-${bill.id}`} className="py-3 first:pt-0 last:pb-0">
                    {isInvoice && bill.cardId ? (
                      <Link
                        href={`/app/pessoal/cartoes/${bill.cardId}`}
                        className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 transition-colors hover:bg-muted/40"
                        aria-label={`${bill.description}, ${formatCurrency(bill.remaining)}, vence em ${formatDueDate(bill.transactionDate)}`}
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
    </div>
  );
}
