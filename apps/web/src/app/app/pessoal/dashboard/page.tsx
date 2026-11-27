'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  ArrowDownRight,
  ArrowLeftRight,
  ArrowUpRight,
  CalendarClock,
  ChevronDown,
} from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useFinancialResources } from '@/hooks/useFinancialResources';
import { resourceQuery, useResourceFilter } from '@/hooks/useResourceFilter';
import { ResourceFilter } from '@/components/resources/ResourceFilter';
import { DateBasisNote } from '@/components/resources/DateBasisNote';
import { CategoryBars } from '@/components/dashboard/CategoryBars';
import { Amount, SectionHeading } from '@/components/dashboard/home-ledger';
import { TopCategories } from '@/components/dashboard/TopCategories';
import { ResourceCategoryChart } from '@/components/dashboard/ResourceCategoryChart';
import { useAuth } from '@/contexts/auth-context';
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
  /** Gastos do mês (parcela no mês dela): realizados e previstos no período. */
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
      overdueForecast: number;
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
function TrendBadge({
  value,
  invert = false,
  versus,
}: {
  value: number | null;
  invert?: boolean;
  /** Nome do mês comparado ("outubro"). */
  versus: string;
}) {
  if (value === null)
    return <span className="text-xs text-muted-foreground">sem dado anterior</span>;
  const isPositive = invert ? value <= 0 : value >= 0;
  const Icon = value >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-medium',
        isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
      )}
    >
      <Icon className="h-3 w-3" />
      {Math.abs(value).toFixed(0)}% vs. {versus}
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

function greeting(date = new Date()) {
  const h = date.getHours();
  if (h < 5 || h >= 18) return 'Boa noite';
  return h < 12 ? 'Bom dia' : 'Boa tarde';
}

/** "2026-10" → "outubro" */
function monthName(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

/** Contas a pagar visíveis antes de "Ver todas". */
const BILLS_PREVIEW = 3;

function DashboardContent() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const { data: resources } = useFinancialResources();
  const { selection, setSelection } = useResourceFilter();
  const scopeParams = new URLSearchParams(resourceQuery(selection)).toString();

  const [evolutionMonths, setEvolutionMonths] = useState(12);
  const [selectedMonth, setSelectedMonth] = useState('');
  const [daily, setDaily] = useState<DailyBreakdown | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [showAllBills, setShowAllBills] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

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

  // O gráfico por dia só existe na análise completa: busca quando ela abre.
  useEffect(() => {
    if (!selectedMonth || !showDetails) return;
    setDailyLoading(true);
    apiClient
      .get<DailyBreakdown>(`/dashboard/daily?month=${selectedMonth}&${scopeParams}`)
      .then(setDaily)
      .catch(console.error)
      .finally(() => setDailyLoading(false));
  }, [selectedMonth, scopeParams, showDetails]);

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
  const isCurrentMonth = !!monthOptions.current && selectedMonth === monthOptions.current;

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
  if (!data) return <div className="text-destructive">Erro ao carregar o início.</div>;

  const firstName = user?.name?.trim().split(/\s+/)[0];
  const previousMonth = selectedMonth ? monthName(addMonths(selectedMonth, -1)) : '';
  const period = isCurrentMonth ? 'neste mês' : `em ${monthName(selectedMonth)}`;
  const savingsRate = data.result.percentOfIncome ?? 0;
  const hasIncome = data.income.received > 0;
  const horizonLabel = formatDueDate(data.commitments.horizon);

  // Com o filtro só em cartões, saldo bancário não é medida daquele recurso:
  // o número principal vira a dívida do cartão.
  const cardOnly = data.cashBalance === null && !!data.cards;
  const heroLabel = cardOnly ? 'Você deve no cartão' : 'Você tem hoje nas contas';
  const heroValue = cardOnly ? (data.cards?.totalDebt ?? 0) : (data.cashBalance ?? 0);

  // Uma frase que diz o que o mês significa, em vez de deixar a conta para quem lê.
  const kept = Math.round(savingsRate);
  let heroSentence: React.ReactNode;
  if (isFutureMonth) {
    heroSentence = (
      <>
        Previsto para {monthName(selectedMonth)}: entram{' '}
        <em className="text-emphasis">{formatCurrency(data.income.pending)}</em> e saem{' '}
        <em className="text-emphasis">{formatCurrency(data.spending.forecast)}</em>.
      </>
    );
  } else if (!hasIncome) {
    heroSentence = <>Ainda não entrou dinheiro {period}.</>;
  } else if (data.result.value < 0) {
    heroSentence = (
      <>
        Você gastou{' '}
        <em className="text-emphasis text-rose-600 dark:text-rose-400">
          {formatCurrency(Math.abs(data.result.value))} a mais
        </em>{' '}
        do que entrou {period}.
      </>
    );
  } else {
    const verdict =
      savingsRate >= 20 ? 'ótimo resultado' : savingsRate >= 10 ? 'isso é bom' : 'dá para melhorar';
    heroSentence = (
      <>
        De cada R$ 100 que entraram {period},{' '}
        <em className="text-emphasis">R$ {kept} ficaram com você</em> — {verdict}.
      </>
    );
  }

  // Proporção do mês: quanto do que entrou saiu e quanto ficou.
  const monthIn = isFutureMonth ? data.income.pending : data.income.received;
  const monthOut = isFutureMonth ? data.spending.forecast : data.spending.realized;
  const outShare = monthIn > 0 ? Math.min(100, (monthOut / monthIn) * 100) : monthOut > 0 ? 100 : 0;
  const keptShare = monthIn > 0 ? Math.max(0, 100 - outShare) : 0;

  const bills = data.upcomingBills;
  const overdueCount = bills.filter((b) => b.isOverdue).length;
  const visibleBills = showAllBills ? bills : bills.slice(0, BILLS_PREVIEW);
  const billsSummary = [
    overdueCount > 0 && `${overdueCount} ${overdueCount === 1 ? 'vencida' : 'vencidas'}`,
    bills.length - overdueCount > 0 && `${bills.length - overdueCount} a vencer`,
  ]
    .filter(Boolean)
    .join(' · ');

  // Gasto fixo é sempre previsão, mas para quem lê é conta: entra em "contas".
  const overdueBills = data.commitments.overdueBills + data.commitments.overdueForecast;
  const dueBills = data.commitments.billsToHorizon + data.commitments.forecastToHorizon;
  const overdueTotal = overdueBills + data.commitments.invoicesOverdue;
  const dueTotal = dueBills + data.commitments.invoicesToHorizon;

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

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Cabeçalho: saudação, mês e filtro de contas/cartões */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg text-muted-foreground sm:text-xl">
          {greeting()}
          {firstName && (
            <>
              , <span className="font-bold text-foreground">{firstName}</span>
            </>
          )}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <ResourceFilter resources={resources} value={selection} onChange={setSelection} />
          <Select
            aria-label="Mês"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="h-9 w-auto rounded-full text-sm"
          >
            <MonthOptions past={monthOptions.past} future={monthOptions.future} />
          </Select>
        </div>
      </div>

      {/* O número principal: o único card da tela, com o brilho e o "Z" da marca */}
      <section
        aria-label="Saldo"
        className="bg-glow-page relative overflow-hidden rounded-3xl border border-border p-6 shadow-sm sm:p-8"
      >
        <span
          aria-hidden
          className="pointer-events-none absolute -bottom-10 -right-6 h-44 w-48 bg-primary opacity-[0.07] [mask:url(/marca/zeloo-simbolo.svg)_center/contain_no-repeat] sm:h-60 sm:w-64"
        />
        <p className="relative font-mono text-xs lowercase tracking-wide text-muted-foreground">
          <span className="text-primary">hoje</span> ·{' '}
          {cardOnly ? 'dívida no cartão' : 'nas contas'}
        </p>
        <Amount
          value={heroValue}
          animate
          className="relative mt-2 text-5xl font-bold tracking-tight sm:text-6xl"
        />
        {!cardOnly && data.investmentsBalance > 0 && (
          <p className="relative mt-1 font-mono text-xs text-muted-foreground">
            + {formatCurrency(data.investmentsBalance)} investidos
          </p>
        )}
        <p className="relative mt-4 max-w-xl text-[15px] leading-relaxed text-muted-foreground sm:text-base">
          {heroSentence}
        </p>
      </section>

      {/* O mês em uma barra: quanto do que entrou saiu e quanto ficou */}
      <section aria-labelledby="dash-mes" className="space-y-4 border-t border-border pt-6">
        <SectionHeading
          id="dash-mes"
          number={1}
          eyebrow={isFutureMonth ? 'o mês · previsto' : 'o mês'}
          title="Quanto entrou e"
          emphasis="quanto saiu"
        />
        <div className="grid grid-cols-2 gap-4">
          {[
            { label: 'Entrou', value: monthIn, change: incomeChange, invert: false },
            { label: 'Saiu', value: monthOut, change: expenseChange, invert: true },
          ].map((item) => (
            <div key={item.label} className="min-w-0 space-y-0.5">
              <p className="text-sm text-muted-foreground">{item.label}</p>
              <Amount value={item.value} className="text-2xl font-bold sm:text-3xl" />
              {!isFutureMonth && (
                <div>
                  <TrendBadge value={item.change} invert={item.invert} versus={previousMonth} />
                </div>
              )}
            </div>
          ))}
        </div>
        <div>
          <div
            className="flex h-3 overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={
              monthIn > 0
                ? `Saiu ${Math.round(outShare)}% do que entrou; ficou ${Math.round(keptShare)}%`
                : 'Sem entradas no mês'
            }
          >
            <div className="h-full bg-rose-500" style={{ width: `${outShare}%` }} />
            <div className="h-full bg-emerald-500" style={{ width: `${keptShare}%` }} />
          </div>
          <div className="mt-2 flex justify-between font-mono text-xs lowercase text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-rose-500" aria-hidden />
              saiu {Math.round(outShare)}%
            </span>
            <span className="flex items-center gap-1.5">
              ficou {Math.round(keptShare)}%
              <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
            </span>
          </div>
        </div>
      </section>

      <div className="grid items-start gap-x-10 gap-y-6 lg:grid-cols-2">
        {/* Pra onde foi o dinheiro */}
        <section
          aria-labelledby="dash-categorias"
          className="min-w-0 space-y-4 border-t border-border pt-6"
        >
          <SectionHeading
            id="dash-categorias"
            number={2}
            eyebrow="categorias"
            title="Pra onde foi"
            emphasis="seu dinheiro"
          />
          <TopCategories slices={data.expensesByCategory} />
        </section>

        {/* Contas a pagar */}
        <section
          aria-labelledby="dash-contas"
          className="min-w-0 space-y-3 border-t border-border pt-6"
        >
          <SectionHeading
            id="dash-contas"
            number={3}
            eyebrow="a pagar"
            title="Próximas"
            emphasis="contas"
            aside={
              <span
                className={cn(
                  'shrink-0 font-mono text-xs lowercase',
                  overdueCount > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground',
                )}
              >
                {billsSummary || 'tudo em dia'}
              </span>
            }
          />
          {bills.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">Nenhuma conta em aberto.</p>
          ) : (
            <>
              <ul className="divide-y divide-border">
                {visibleBills.map((bill) => (
                  <BillRow key={`${bill.kind}-${bill.id}`} bill={bill} />
                ))}
              </ul>
              {bills.length > BILLS_PREVIEW && (
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={() => setShowAllBills((v) => !v)}
                >
                  {showAllBills ? 'Mostrar menos' : `Ver todas (${bills.length})`}
                </Button>
              )}
            </>
          )}
        </section>
      </div>

      {/* Tudo o que é análise fica recolhido: quem quer o detalhe abre. */}
      <div>
        <Button
          variant="outline"
          className="w-full rounded-xl"
          aria-expanded={showDetails}
          aria-controls="dash-analise"
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? 'Esconder análise completa' : 'Ver análise completa'}
          <ChevronDown
            className={cn('h-4 w-4 transition-transform', showDetails && 'rotate-180')}
          />
        </Button>
      </div>

      {showDetails && (
        <div id="dash-analise" className="space-y-4 sm:space-y-6">
          <DateBasisNote variant="spending" />

          {/* Compromissos, cartões e projeção — por vencimento, a partir de hoje */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
            <Card className="rounded-2xl">
              <CardContent className="space-y-1 p-4">
                <p className="text-xs font-medium text-muted-foreground">Vencidas e não pagas</p>
                <p
                  className={cn(
                    'text-lg font-bold',
                    overdueTotal > 0 ? 'text-rose-600 dark:text-rose-400' : undefined,
                  )}
                >
                  {formatCurrency(overdueTotal)}
                </p>
                <p className="text-xs text-muted-foreground">
                  contas {formatCurrency(overdueBills)} · faturas{' '}
                  {formatCurrency(data.commitments.invoicesOverdue)}
                </p>
              </CardContent>
            </Card>
            <Card className="rounded-2xl">
              <CardContent className="space-y-1 p-4">
                <p className="text-xs font-medium text-muted-foreground">
                  A vencer até {horizonLabel}
                </p>
                <p className="text-lg font-bold">{formatCurrency(dueTotal)}</p>
                <p className="text-xs text-muted-foreground">
                  contas {formatCurrency(dueBills)} · faturas{' '}
                  {formatCurrency(data.commitments.invoicesToHorizon)}
                </p>
              </CardContent>
            </Card>
            <Card className="rounded-2xl">
              <CardContent className="space-y-1 p-4">
                <p className="text-xs font-medium text-muted-foreground">
                  Dívida efetiva no cartão
                </p>
                {data.cards ? (
                  <>
                    <p className="text-lg font-bold">{formatCurrency(data.cards.totalDebt)}</p>
                    <p className="text-xs text-muted-foreground">
                      parcelas futuras a pagar {formatCurrency(data.cards.futureInstallments)}
                    </p>
                    {data.cards.creditBalance > 0 && (
                      <p className="text-xs text-emerald-700 dark:text-emerald-400">
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
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        {data.cards.incompleteCards} cartão(ões) sem configuração: dívida
                        desconhecida
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
                        data.projected.value < 0 ? 'text-rose-600 dark:text-rose-400' : undefined,
                      )}
                    >
                      {formatCurrency(data.projected.value)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      saldo em contas + a receber (
                      {formatCurrency(data.projected.components.receivable)}) − contas vencidas e a
                      vencer e faturas até {horizonLabel}. Não é saldo bancário nem patrimônio.
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
              {data.loansDebt > 0 && (
                <p className="text-xs text-muted-foreground">
                  Empréstimos a pagar: {formatCurrency(data.loansDebt)}.
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

          {/* Despesas por categoria: consolidado, contas e cartões */}
          <div className="grid items-start gap-4 sm:gap-6 lg:grid-cols-3">
            <CategoryBars
              title={'Todas as\ncategorias'}
              subtitle={
                filterActive
                  ? 'Gastos do mês no filtro · parcela no mês dela'
                  : 'Gastos do mês · parcela no mês dela'
              }
              slices={data.expensesByCategory}
            />
            <ResourceCategoryChart
              kind="accounts"
              resources={chartAccounts}
              periodStart={periodStart}
              periodEnd={periodEnd}
              emptyText={
                filterActive ? 'Nenhuma conta no filtro atual' : 'Nenhuma conta cadastrada'
              }
            />
            <ResourceCategoryChart
              kind="cards"
              resources={chartCards}
              periodStart={periodStart}
              periodEnd={periodEnd}
              emptyText={
                filterActive ? 'Nenhum cartão no filtro atual' : 'Nenhum cartão cadastrado'
              }
            />
          </div>

          {/* Evolução mensal + Lançamentos diários */}
          <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
            <Card className="rounded-2xl">
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="text-base">Receitas x Gastos</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Receitas recebidas e gastos do mês (parcela no mês dela)
                  </p>
                </div>
                <Select
                  aria-label="Período do gráfico"
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
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="hsl(var(--border))"
                    />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
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
              <CardHeader>
                <CardTitle className="text-base">
                  Gastos e receitas por dia · {monthLabelFull(selectedMonth)}
                </CardTitle>
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
        </div>
      )}
    </div>
  );
}

/** Dias entre hoje e o vencimento (negativo: já venceu). */
function daysUntil(iso: string) {
  const due = new Date(`${iso.slice(0, 10)}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

function dueText(days: number) {
  if (days < -1) return `Venceu há ${-days} dias`;
  if (days === -1) return 'Venceu ontem';
  if (days === 0) return 'Vence hoje';
  if (days === 1) return 'Vence amanhã';
  return `Vence em ${days} dias`;
}

/**
 * Uma conta a pagar. A data é o que importa, então ela vira o selo da
 * esquerda ("10 dez"); vencida, o selo e o texto ficam vermelhos.
 */
function BillRow({ bill }: { bill: UpcomingBill }) {
  const isInvoice = bill.kind === 'invoice';
  const date = new Date(`${bill.transactionDate.slice(0, 10)}T00:00:00`);
  const day = String(date.getDate()).padStart(2, '0');
  const month = date.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
  const days = daysUntil(bill.transactionDate);
  const overdue = bill.isOverdue;
  const detail = [
    dueText(days),
    isInvoice ? (bill.invoiceState === 'open' ? 'fatura aberta' : 'fatura') : bill.category?.name,
  ]
    .filter(Boolean)
    .join(' · ');
  const content = (
    <>
      <span
        className={cn(
          'flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl border leading-none',
          overdue
            ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300'
            : 'border-border bg-card',
        )}
        aria-hidden
      >
        <span className="text-base font-bold tabular-nums">{day}</span>
        <span
          className={cn(
            'mt-0.5 font-mono text-[10px] lowercase',
            overdue ? undefined : 'text-muted-foreground',
          )}
        >
          {month}
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{bill.description}</span>
        <span
          className={cn(
            'block truncate text-xs',
            overdue ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-muted-foreground',
          )}
        >
          {detail}
        </span>
      </span>
      <span className="shrink-0 text-sm font-bold tabular-nums">
        {formatCurrency(bill.remaining)}
      </span>
    </>
  );
  return (
    <li className="py-3">
      {isInvoice && bill.cardId ? (
        <Link
          // A fatura é identificada pelo mês do vencimento.
          href={`/app/pessoal/faturas?cartao=${bill.cardId}&mes=${bill.transactionDate.slice(0, 7)}`}
          className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-1 transition-colors hover:bg-muted/40"
          aria-label={`${bill.description}, ${formatCurrency(bill.remaining)}, vence em ${formatDueDate(bill.transactionDate)}`}
        >
          {content}
        </Link>
      ) : (
        <div className="flex items-center gap-3">{content}</div>
      )}
    </li>
  );
}
