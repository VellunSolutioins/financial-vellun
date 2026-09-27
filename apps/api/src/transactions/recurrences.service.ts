import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RecurrenceFrequency } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { dateOnlyString, startOfDayUtc, todaySaoPaulo } from '../common/date.util';
import { TransactionsService } from './transactions.service';
import { FREQUENCY_STEP_MONTHS } from './recurrence-frequency';
import { UpdateRecurrenceDto } from './dto/update-recurrence.dto';

/**
 * Recorrência não é uma entidade própria: é a série de lançamentos fixos com o
 * mesmo `seriesId`. A tela de Lançamentos mostra as ocorrências; a de
 * Recorrências mostra uma linha por série. Toda ação aqui (editar, pausar,
 * excluir) atua nas ocorrências de hoje em diante — as passadas ficam como
 * estão, porque já aconteceram.
 */

const occurrenceInclude = {
  category: { select: { id: true, name: true, color: true } },
  account: { select: { id: true, name: true } },
} satisfies Prisma.TransactionInclude;

export type Occurrence = Prisma.TransactionGetPayload<{ include: typeof occurrenceInclude }>;

/** Faixas de comprometimento da receita fixa com despesas fixas. */
const FIXED_HEALTH_BANDS = [
  { max: 40, key: 'excelente', label: 'Excelente margem' },
  { max: 50, key: 'saudavel', label: 'Saudável' },
  { max: 60, key: 'atencao', label: 'Atenção' },
  { max: 70, key: 'apertado', label: 'Orçamento apertado' },
] as const;

export type FixedTotalRow = {
  type: string;
  categoryId: string | null;
  categoryName: string | null;
  color: string | null;
  total: number;
};

/**
 * Agrupa as ocorrências futuras (já ordenadas por data) em recorrências.
 *
 * Ativa = ainda tem ocorrência confirmada pela frente; pausada = todas as
 * futuras estão canceladas. O dia de vencimento é o maior dia entre as
 * ocorrências: uma série no dia 31 cai em 28/30 nos meses curtos.
 */
export function groupRecurrences(occurrences: Occurrence[]) {
  const bySeries = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    if (!occurrence.seriesId) continue;
    const list = bySeries.get(occurrence.seriesId) ?? [];
    list.push(occurrence);
    bySeries.set(occurrence.seriesId, list);
  }

  return [...bySeries.entries()].map(([seriesId, list]) => {
    const confirmed = list.filter((o) => o.status === 'confirmed');
    const next = confirmed[0] ?? list[0];
    return {
      seriesId,
      description: next.description,
      type: next.type,
      amount: Number(next.amount),
      frequency: next.recurrenceFrequency ?? 'monthly',
      dueDay: Math.max(...list.map((o) => o.transactionDate.getUTCDate())),
      isActive: confirmed.length > 0,
      nextDate: next.transactionDate,
      remaining: confirmed.length,
      accountId: next.accountId,
      categoryId: next.categoryId,
      account: next.account,
      category: next.category,
    };
  });
}

export type Recurrence = ReturnType<typeof groupRecurrences>[number];

/** Valor da recorrência convertido para o equivalente mensal (anual ÷ 12 etc.). */
export function monthlyEquivalent(r: Pick<Recurrence, 'amount' | 'frequency'>): number {
  return r.amount / FREQUENCY_STEP_MONTHS[r.frequency as RecurrenceFrequency];
}

/**
 * Receita fixa, despesa fixa ("comprometido"), faixa de saúde e divisão das
 * despesas por categoria. Sem receita fixa não há percentual a calcular.
 */
export function buildFixedSummary(rows: FixedTotalRow[]) {
  const expenses = rows.filter((r) => r.type === 'expense');
  const income = rows.filter((r) => r.type === 'income').reduce((s, r) => s + r.total, 0);
  const committed = expenses.reduce((s, r) => s + r.total, 0);

  const byCategoryMap = new Map<string, FixedTotalRow>();
  for (const r of expenses) {
    const key = r.categoryId ?? 'uncategorized';
    const entry = byCategoryMap.get(key);
    if (entry) entry.total += r.total;
    else byCategoryMap.set(key, { ...r });
  }
  const byCategory = [...byCategoryMap.values()]
    .map((r) => ({
      categoryId: r.categoryId,
      categoryName: r.categoryName ?? 'Sem categoria',
      color: r.color,
      total: r.total,
      percentage: committed > 0 ? (r.total / committed) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  if (income <= 0) {
    return {
      income,
      committed,
      percentage: 0,
      health: { key: 'sem_receita', label: 'Cadastre uma receita fixa' },
      byCategory,
    };
  }

  const percentage = (committed / income) * 100;
  const band = FIXED_HEALTH_BANDS.find((b) => percentage <= b.max);
  const health = band
    ? { key: band.key, label: band.label }
    : { key: 'alto_risco', label: 'Alto risco' };
  return { income, committed, percentage, health, byCategory };
}

/** Mesma data, com o dia trocado (limitado ao último dia do mês). */
export function withDay(date: Date, day: number): Date {
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), Math.min(day, lastDay), 12, 0, 0),
  );
}

@Injectable()
export class RecurrencesService {
  constructor(
    private prisma: PrismaService,
    private accountsService: AccountsService,
    private transactionsService: TransactionsService,
  ) {}

  private fromToday() {
    return { gte: startOfDayUtc(dateOnlyString(todaySaoPaulo())) };
  }

  async findAll(userId: string) {
    const occurrences = await this.prisma.transaction.findMany({
      where: {
        userId,
        recurrenceType: 'fixo',
        seriesId: { not: null },
        transactionDate: this.fromToday(),
      },
      include: occurrenceInclude,
      orderBy: { transactionDate: 'asc' },
    });
    return groupRecurrences(occurrences).sort((a, b) =>
      a.isActive === b.isActive ? a.nextDate.getTime() - b.nextDate.getTime() : a.isActive ? -1 : 1,
    );
  }

  /** Comprometimento com fixos, no equivalente mensal das recorrências ativas. */
  async summary(userId: string) {
    const active = (await this.findAll(userId)).filter((r) => r.isActive);
    return buildFixedSummary(
      active.map((r) => ({
        type: r.type,
        categoryId: r.categoryId,
        categoryName: r.category?.name ?? null,
        color: r.category?.color ?? null,
        total: monthlyEquivalent(r),
      })),
    );
  }

  async update(userId: string, seriesId: string, dto: UpdateRecurrenceDto) {
    const future = await this.findFuture(userId, seriesId);
    if (dto.accountId !== undefined || dto.categoryId !== undefined) {
      await this.transactionsService.validateOwnership(userId, dto.accountId, dto.categoryId);
    }

    const data: Prisma.TransactionUncheckedUpdateManyInput = {
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.amount !== undefined && { amount: dto.amount }),
      ...(dto.accountId !== undefined && { accountId: dto.accountId }),
      ...(dto.categoryId !== undefined && { categoryId: dto.categoryId || null }),
    };

    await this.prisma.$transaction(
      future.map((occurrence) =>
        this.prisma.transaction.update({
          where: { id: occurrence.id },
          data: {
            ...data,
            ...(dto.dueDay !== undefined && {
              transactionDate: withDay(occurrence.transactionDate, dto.dueDay),
            }),
          },
        }),
      ),
    );

    await this.recalculate(future, dto.accountId);
    return this.findOneOrFail(userId, seriesId);
  }

  /** Pausar cancela as ocorrências de hoje em diante; reativar as confirma de novo. */
  async setActive(userId: string, seriesId: string, active: boolean) {
    const future = await this.findFuture(userId, seriesId);
    await this.prisma.transaction.updateMany({
      where: {
        userId,
        seriesId,
        transactionDate: this.fromToday(),
        status: active ? 'cancelled' : 'confirmed',
      },
      data: { status: active ? 'confirmed' : 'cancelled' },
    });
    await this.recalculate(future);
    return this.findOneOrFail(userId, seriesId);
  }

  /** Exclui as ocorrências de hoje em diante. As passadas não são afetadas. */
  async remove(userId: string, seriesId: string) {
    const future = await this.findFuture(userId, seriesId);
    await this.prisma.transaction.deleteMany({
      where: { userId, seriesId, transactionDate: this.fromToday() },
    });
    await this.recalculate(future);
    return { message: 'Recorrência excluída' };
  }

  private async findFuture(userId: string, seriesId: string) {
    const future = await this.prisma.transaction.findMany({
      where: {
        userId,
        seriesId,
        recurrenceType: 'fixo',
        transactionDate: this.fromToday(),
      },
      orderBy: { transactionDate: 'asc' },
    });
    if (future.length === 0) throw new NotFoundException('Recorrência não encontrada');
    return future;
  }

  private async findOneOrFail(userId: string, seriesId: string) {
    const occurrences = await this.prisma.transaction.findMany({
      where: { userId, seriesId, transactionDate: this.fromToday() },
      include: occurrenceInclude,
      orderBy: { transactionDate: 'asc' },
    });
    const [recurrence] = groupRecurrences(occurrences);
    if (!recurrence) throw new NotFoundException('Recorrência não encontrada');
    return recurrence;
  }

  /** Recalcula o saldo das contas tocadas (a de hoje entra no saldo). */
  private async recalculate(occurrences: { accountId: string }[], newAccountId?: string) {
    const accountIds = new Set(occurrences.map((o) => o.accountId));
    if (newAccountId) accountIds.add(newAccountId);
    for (const accountId of accountIds) {
      await this.accountsService.recalculateBalance(accountId);
    }
  }
}
