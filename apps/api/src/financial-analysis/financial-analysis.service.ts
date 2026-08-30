import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { startOfMonthUtc, endOfMonthUtc } from '../common/date.util';
import { CreditCardsService } from '../credit-cards/credit-cards.service';
import { SavingsBoxesService } from '../savings-boxes/savings-boxes.service';
import { SpendingGoalsService } from '../spending-goals/spending-goals.service';
import { RemindersService } from '../reminders/reminders.service';

/** Faixas de classificação — mesmo padrão (0–100) usado nos 7 scores. */
const BANDS = [
  { max: 39, key: 'fraco', label: 'Fraco' },
  { max: 59, key: 'regular', label: 'Regular' },
  { max: 79, key: 'bom', label: 'Bom' },
] as const;

function bandFromScore(score: number): { key: string; label: string } {
  for (const band of BANDS) {
    if (score <= band.max) return { key: band.key, label: band.label };
  }
  return { key: 'excelente', label: 'Excelente' };
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
  return Math.round(value);
}

export interface ScoreResult {
  key: string;
  title: string;
  emoji: string;
  score: number;
  band: { key: string; label: string };
  description: string;
  indicators: { label: string; value: string }[];
}

interface MonthTotals {
  month: string;
  income: number;
  expense: number;
}

@Injectable()
export class FinancialAnalysisService {
  constructor(
    private prisma: PrismaService,
    private creditCardsService: CreditCardsService,
    private savingsBoxesService: SavingsBoxesService,
    private spendingGoalsService: SpendingGoalsService,
    private remindersService: RemindersService,
  ) {}

  async getScores(userId: string): Promise<ScoreResult[]> {
    const now = new Date();
    const curStart = startOfMonthUtc(now.getFullYear(), now.getMonth());
    const curEnd = endOfMonthUtc(now.getFullYear(), now.getMonth());

    // Janela de 6 meses (mês atual + 5 anteriores), usada por vários scores.
    const sixMonthsStart = startOfMonthUtc(now.getFullYear(), now.getMonth() - 5);

    const [
      accounts,
      transactions6m,
      contributions6m,
      cards,
      boxes,
      goals,
      reminders,
    ] = await Promise.all([
      this.prisma.account.findMany({ where: { userId, isActive: true } }),
      this.prisma.transaction.findMany({
        where: {
          userId,
          status: 'confirmed',
          type: { in: ['income', 'expense'] },
          transactionDate: { gte: sixMonthsStart, lte: curEnd },
        },
        select: { type: true, amount: true, transactionDate: true, categoryId: true, recurrenceType: true },
      }),
      this.prisma.savingsContribution.findMany({
        where: {
          savingsBox: { userId },
          contributedAt: { gte: sixMonthsStart, lte: curEnd },
        },
        select: { amount: true, contributedAt: true, yieldCompetence: true },
      }),
      this.creditCardsService.findAll(userId),
      this.savingsBoxesService.findAll(userId),
      this.spendingGoalsService.findAll(userId),
      this.remindersService.findAll(userId),
    ]);

    const monthTotals = this.buildMonthTotals(transactions6m, now);
    const currentMonth = monthTotals[monthTotals.length - 1];
    const income = currentMonth.income;
    const expense = currentMonth.expense;

    const currentMonthTx = transactions6m.filter(
      (t) => t.transactionDate >= curStart && t.transactionDate <= curEnd,
    );
    const categorizedRatio =
      currentMonthTx.length > 0
        ? currentMonthTx.filter((t) => t.categoryId !== null).length / currentMonthTx.length
        : 1;

    return [
      this.saudeFinanceira(income, expense),
      this.investimento(income, contributions6m, boxes),
      this.seguranca(monthTotals, boxes),
      this.credito(cards, income),
      this.controle(accounts.length, goals.length, categorizedRatio),
      this.metas(goals, boxes),
      this.consistencia(monthTotals, contributions6m, reminders),
    ];
  }

  /** Agrega receitas/despesas confirmadas por mês (últimos 6 meses, incluindo o atual). */
  private buildMonthTotals(
    transactions: { type: string; amount: unknown; transactionDate: Date }[],
    now: Date,
  ): MonthTotals[] {
    const months: MonthTotals[] = [];
    for (let i = 5; i >= 0; i--) {
      const ref = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
      const key = `${ref.getUTCFullYear()}-${String(ref.getUTCMonth() + 1).padStart(2, '0')}`;
      months.push({ month: key, income: 0, expense: 0 });
    }
    const byKey = new Map(months.map((m) => [m.month, m]));
    for (const t of transactions) {
      const key = `${t.transactionDate.getUTCFullYear()}-${String(t.transactionDate.getUTCMonth() + 1).padStart(2, '0')}`;
      const entry = byKey.get(key);
      if (!entry) continue;
      const amount = Number(t.amount);
      if (t.type === 'income') entry.income += amount;
      else entry.expense += amount;
    }
    return months;
  }

  private saudeFinanceira(income: number, expense: number): ScoreResult {
    const savingsRate = income > 0 ? ((income - expense) / income) * 100 : expense > 0 ? -100 : 0;
    const score = round(clamp(50 + savingsRate * 1.25));
    return {
      key: 'saude_financeira',
      title: 'Score de Saúde Financeira',
      emoji: '💰',
      score,
      band: bandFromScore(score),
      description: 'Visão geral entre receitas, despesas e quanto sobra no mês.',
      indicators: [
        { label: 'Receita do mês', value: formatBRL(income) },
        { label: 'Despesas do mês', value: formatBRL(expense) },
        { label: 'Taxa de economia', value: `${round(savingsRate)}%` },
      ],
    };
  }

  private investimento(
    income: number,
    contributions6m: { amount: unknown; contributedAt: Date; yieldCompetence: string | null }[],
    boxes: Awaited<ReturnType<SavingsBoxesService['findAll']>>,
  ): ScoreResult {
    const now = new Date();
    const curKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const contributedInMonth = contributions6m
      .filter((c) => `${c.contributedAt.getUTCFullYear()}-${String(c.contributedAt.getUTCMonth() + 1).padStart(2, '0')}` === curKey)
      .reduce((sum, c) => sum + Number(c.amount), 0);

    const investRate = income > 0 ? (contributedInMonth / income) * 100 : 0;

    // Meses (últimos 3) com pelo menos um aporte manual (yieldCompetence null = não veio do rendimento automático).
    const last3Keys = [0, 1, 2].map((i) => {
      const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      return `${ref.getUTCFullYear()}-${String(ref.getUTCMonth() + 1).padStart(2, '0')}`;
    });
    const monthsWithManualContribution = new Set(
      contributions6m
        .filter((c) => c.yieldCompetence === null)
        .map((c) => `${c.contributedAt.getUTCFullYear()}-${String(c.contributedAt.getUTCMonth() + 1).padStart(2, '0')}`),
    );
    const regularMonths = last3Keys.filter((k) => monthsWithManualContribution.has(k)).length;
    const regularityScore = (regularMonths / 3) * 100;

    const boxesWithGoal = boxes.filter((b) => b.targetAmount !== null);
    const avgGoalProgress =
      boxesWithGoal.length > 0
        ? boxesWithGoal.reduce((sum, b) => sum + clamp(b.percentage ?? 0), 0) / boxesWithGoal.length
        : null;

    const score =
      avgGoalProgress !== null
        ? round(0.5 * clamp(investRate * 5) + 0.3 * regularityScore + 0.2 * avgGoalProgress)
        : round(0.6 * clamp(investRate * 5) + 0.4 * regularityScore);

    return {
      key: 'investimento',
      title: 'Score de Investimento',
      emoji: '📈',
      score,
      band: bandFromScore(score),
      description: 'Capacidade e hábito de guardar dinheiro para objetivos (Caixinhas).',
      indicators: [
        { label: 'Investido este mês', value: formatBRL(contributedInMonth) },
        { label: '% da renda investida', value: `${round(investRate)}%` },
        { label: 'Meses com aporte (últimos 3)', value: `${regularMonths}/3` },
      ],
    };
  }

  private seguranca(
    monthTotals: MonthTotals[],
    boxes: Awaited<ReturnType<SavingsBoxesService['findAll']>>,
  ): ScoreResult {
    const diacriticsRange = String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f);
    const DIACRITICS_RE = new RegExp('[' + diacriticsRange + ']', 'g');
    const normalize = (s: string) => s.normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase();
    const reserveBoxes = boxes.filter((b) => {
      const n = normalize(b.name);
      return n.includes('reserva') || n.includes('emergencia');
    });
    const reserveSaved = reserveBoxes.reduce((sum, b) => sum + b.saved, 0);

    const expenses = monthTotals.map((m) => m.expense).filter((e) => e > 0);
    const avgExpense = expenses.length > 0 ? expenses.reduce((a, b) => a + b, 0) / expenses.length : 0;
    const reserveMonths = avgExpense > 0 ? reserveSaved / avgExpense : 0;
    const reserveScore = clamp((reserveMonths / 6) * 100);

    let stabilityScore: number | null = null;
    if (expenses.length >= 2) {
      const mean = avgExpense;
      const variance = expenses.reduce((sum, e) => sum + (e - mean) ** 2, 0) / expenses.length;
      const coefVar = mean > 0 ? Math.sqrt(variance) / mean : 0;
      stabilityScore = clamp(100 - coefVar * 150);
    }

    const score = round(stabilityScore !== null ? (reserveScore + stabilityScore) / 2 : reserveScore);

    return {
      key: 'seguranca',
      title: 'Score de Segurança',
      emoji: '🛡',
      score,
      band: bandFromScore(score),
      description:
        'Reserva de emergência e estabilidade das despesas. Sem dado de seguros contratados no sistema hoje — não entra no cálculo.',
      indicators: [
        { label: 'Reserva de emergência', value: formatBRL(reserveSaved) },
        {
          label: 'Meses de despesas cobertos',
          value: avgExpense > 0 ? reserveMonths.toFixed(1) : '—',
        },
        {
          label: 'Estabilidade das despesas',
          value: stabilityScore !== null ? `${round(stabilityScore)}/100` : 'sem dado suficiente',
        },
      ],
    };
  }

  private credito(cards: Awaited<ReturnType<CreditCardsService['findAll']>>, income: number): ScoreResult {
    if (cards.length === 0) {
      return {
        key: 'credito',
        title: 'Score de Crédito',
        emoji: '💳',
        score: 90,
        band: bandFromScore(90),
        description: 'Sem cartões cadastrados — nenhuma dependência de crédito monitorada.',
        indicators: [{ label: 'Cartões cadastrados', value: '0' }],
      };
    }

    const withLimit = cards.filter((c) => c.creditLimit !== null && c.creditLimit > 0);
    const avgUtilization =
      withLimit.length > 0
        ? withLimit.reduce((sum, c) => sum + (c.currentInvoice / (c.creditLimit ?? 1)) * 100, 0) / withLimit.length
        : 0;

    const totalInvoice = cards.reduce((sum, c) => sum + c.currentInvoice, 0);
    const invoiceToIncome = income > 0 ? (totalInvoice / income) * 100 : 0;

    const score = round(clamp(100 - avgUtilization * 0.5 - invoiceToIncome * 0.6));

    return {
      key: 'credito',
      title: 'Score de Crédito',
      emoji: '💳',
      score,
      band: bandFromScore(score),
      description: 'Uso do limite dos cartões e peso da fatura na sua renda.',
      indicators: [
        { label: 'Fatura total', value: formatBRL(totalInvoice) },
        { label: 'Uso médio do limite', value: withLimit.length > 0 ? `${round(avgUtilization)}%` : 'sem limite definido' },
        { label: 'Fatura / renda', value: income > 0 ? `${round(invoiceToIncome)}%` : '—' },
      ],
    };
  }

  private controle(accountCount: number, goalCount: number, categorizedRatio: number): ScoreResult {
    const accountsScore = accountCount >= 1 ? 100 : 0;
    const goalsScore = clamp(goalCount * 20);
    const score = round(0.2 * accountsScore + 0.3 * goalsScore + 0.5 * categorizedRatio * 100);

    return {
      key: 'controle',
      title: 'Score de Controle',
      emoji: '📊',
      score,
      band: bandFromScore(score),
      description: 'Organização: contas cadastradas, metas por categoria e lançamentos categorizados.',
      indicators: [
        { label: 'Contas ativas', value: String(accountCount) },
        { label: 'Metas de gastos', value: String(goalCount) },
        { label: 'Lançamentos categorizados (mês)', value: `${round(categorizedRatio * 100)}%` },
      ],
    };
  }

  private metas(
    goals: Awaited<ReturnType<SpendingGoalsService['findAll']>>,
    boxes: Awaited<ReturnType<SavingsBoxesService['findAll']>>,
  ): ScoreResult {
    const totalGoals = goals.length + boxes.length;
    const creationScore = clamp(totalGoals * 10);

    const boxesWithGoal = boxes.filter((b) => b.targetAmount !== null);
    const avgBoxProgress =
      boxesWithGoal.length > 0
        ? boxesWithGoal.reduce((sum, b) => sum + clamp(b.percentage ?? 0), 0) / boxesWithGoal.length
        : null;

    const adherence =
      goals.length > 0 ? goals.filter((g) => g.percentage <= 100).length / goals.length : null;

    const parts: number[] = [creationScore];
    const weights: number[] = [0.25];
    if (avgBoxProgress !== null) {
      parts.push(avgBoxProgress);
      weights.push(0.4);
    }
    if (adherence !== null) {
      parts.push(adherence * 100);
      weights.push(0.35);
    }
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const score = round(parts.reduce((sum, p, i) => sum + p * weights[i], 0) / totalWeight);

    return {
      key: 'metas',
      title: 'Score de Metas',
      emoji: '🎯',
      score,
      band: bandFromScore(score),
      description: 'Quantas metas você definiu e como está indo em relação a elas.',
      indicators: [
        { label: 'Metas de gastos + caixinhas', value: String(totalGoals) },
        {
          label: 'Progresso médio das caixinhas',
          value: avgBoxProgress !== null ? `${round(avgBoxProgress)}%` : 'sem meta definida',
        },
        {
          label: 'Categorias dentro do orçamento',
          value: adherence !== null ? `${round(adherence * 100)}%` : 'sem meta de gastos',
        },
      ],
    };
  }

  private consistencia(
    monthTotals: MonthTotals[],
    contributions6m: { yieldCompetence: string | null; contributedAt: Date }[],
    reminders: Awaited<ReturnType<RemindersService['findAll']>>,
  ): ScoreResult {
    const positiveMonths = monthTotals.filter((m) => m.income >= m.expense && m.income > 0).length;
    const positiveScore = (positiveMonths / monthTotals.length) * 100;

    const monthsWithManualContribution = new Set(
      contributions6m
        .filter((c) => c.yieldCompetence === null)
        .map((c) => `${c.contributedAt.getUTCFullYear()}-${String(c.contributedAt.getUTCMonth() + 1).padStart(2, '0')}`),
    );
    const investmentScore = (monthsWithManualContribution.size / monthTotals.length) * 100;

    const relevantReminders = reminders.filter((r) => r.derivedStatus !== 'paid' || r.isRecurrent);
    const overdueCount = reminders.filter((r) => r.derivedStatus === 'overdue').length;
    const paymentScore =
      relevantReminders.length > 0 ? clamp(100 - (overdueCount / relevantReminders.length) * 150) : 70;

    const score = round(0.4 * positiveScore + 0.3 * clamp(investmentScore) + 0.3 * paymentScore);

    return {
      key: 'consistencia',
      title: 'Score de Consistência',
      emoji: '🔄',
      score,
      band: bandFromScore(score),
      description: 'Disciplina ao longo dos últimos 6 meses: saldo positivo, investimento recorrente e contas em dia.',
      indicators: [
        { label: 'Meses com saldo positivo', value: `${positiveMonths}/${monthTotals.length}` },
        { label: 'Meses com aporte', value: `${monthsWithManualContribution.size}/${monthTotals.length}` },
        { label: 'Lembretes vencidos agora', value: String(overdueCount) },
      ],
    };
  }
}

function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
