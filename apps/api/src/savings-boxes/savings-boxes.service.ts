import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  calendarDayFromUtcDate,
  dateOnlyString,
  parseDateOnly,
  todaySaoPaulo,
  type CalendarDay,
} from '../common/date.util';

import { CreateSavingsBoxDto } from './dto/create-savings-box.dto';
import { UpdateSavingsBoxDto } from './dto/update-savings-box.dto';
import { CreateContributionDto } from './dto/create-contribution.dto';

/** Selos de progresso em direção à meta (só aplicável quando há targetAmount). */
const PROGRESS_BANDS = [
  { max: 16, key: 'primeiro_passo', label: 'Primeiro Passo', message: 'Começou! O primeiro passo já foi dado.' },
  { max: 33, key: 'avancando', label: 'Avançando', message: 'Boa! Você está progredindo.' },
  { max: 50, key: 'no_caminho', label: 'No Caminho', message: 'Metade da meta alcançada!' },
  { max: 75, key: 'acelerando', label: 'Acelerando', message: 'Está ficando perto!' },
  { max: 99, key: 'quase_la', label: 'Quase Lá', message: 'Falta muito pouco!' },
] as const;

function progressFromPercentage(percentage: number): { key: string; label: string; message: string } {
  for (const band of PROGRESS_BANDS) {
    if (percentage <= band.max) return { key: band.key, label: band.label, message: band.message };
  }
  return { key: 'meta_conquistada', label: 'Meta Conquistada', message: 'Você conseguiu! Meta alcançada! 🎉' };
}

@Injectable()
export class SavingsBoxesService {
  private readonly logger = new Logger(SavingsBoxesService.name);

  constructor(private prisma: PrismaService) {}

  private toBoxView<
    T extends {
      contributions: { amount: Prisma.Decimal }[];
      targetAmount: Prisma.Decimal | null;
      yieldRate: Prisma.Decimal | null;
    },
  >(box: T) {
    const contributions = box.contributions.map((c) => ({ ...c, amount: Number(c.amount) }));
    const saved = contributions.reduce((sum, c) => sum + c.amount, 0);
    const targetAmount = box.targetAmount ? Number(box.targetAmount) : null;
    const percentage = targetAmount ? (saved / targetAmount) * 100 : null;
    return {
      ...box,
      contributions,
      targetAmount,
      yieldRate: box.yieldRate ? Number(box.yieldRate) : null,
      saved,
      percentage,
      progress: percentage !== null ? progressFromPercentage(percentage) : null,
    };
  }

  async findAll(userId: string) {
    const boxes = await this.prisma.savingsBox.findMany({
      where: { userId },
      include: { contributions: { orderBy: { contributedAt: 'desc' } } },
      orderBy: { createdAt: 'asc' },
    });
    return boxes.map((box) => this.toBoxView(box));
  }

  async summary(userId: string) {
    const boxes = await this.findAll(userId);
    const totalSaved = boxes.reduce((sum, b) => sum + b.saved, 0);
    const top = [...boxes].sort((a, b) => b.saved - a.saved).slice(0, 3);
    return { totalSaved, boxCount: boxes.length, top };
  }

  async create(userId: string, dto: CreateSavingsBoxDto) {
    const box = await this.prisma.savingsBox.create({
      data: {
        userId,
        name: dto.name,
        color: dto.color ?? null,
        targetAmount: dto.targetAmount ?? null,
        targetDate: dto.targetDate ? parseDateOnly(dto.targetDate) : null,
        yieldRate: dto.yieldRate ?? null,
        yieldPeriod: dto.yieldPeriod ?? null,
      },
      include: { contributions: true },
    });
    return this.toBoxView(box);
  }

  async update(userId: string, id: string, dto: UpdateSavingsBoxDto) {
    await this.findOwned(userId, id);
    const box = await this.prisma.savingsBox.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.targetAmount !== undefined && { targetAmount: dto.targetAmount }),
        ...(dto.targetDate !== undefined && { targetDate: dto.targetDate ? parseDateOnly(dto.targetDate) : null }),
        ...(dto.yieldRate !== undefined && { yieldRate: dto.yieldRate }),
        ...(dto.yieldPeriod !== undefined && { yieldPeriod: dto.yieldPeriod }),
      },
      include: { contributions: true },
    });
    return this.toBoxView(box);
  }

  async remove(userId: string, id: string) {
    await this.findOwned(userId, id);
    return this.prisma.savingsBox.delete({ where: { id } });
  }

  async addContribution(userId: string, boxId: string, dto: CreateContributionDto) {
    await this.findOwned(userId, boxId);
    await this.prisma.savingsContribution.create({
      data: {
        savingsBoxId: boxId,
        amount: dto.amount,
        contributedAt: dto.contributedAt ? parseDateOnly(dto.contributedAt) : parseDateOnly(todayIso()),
        note: dto.note ?? null,
      },
    });
    const box = await this.prisma.savingsBox.findUniqueOrThrow({
      where: { id: boxId },
      include: { contributions: { orderBy: { contributedAt: 'desc' } } },
    });
    return this.toBoxView(box);
  }

  /** Roda diariamente às 04:00 (São Paulo) — aplica rendimento às caixinhas que têm taxa definida. */
  @Cron('0 4 * * *', { timeZone: 'America/Sao_Paulo' })
  async applyYieldForAllUsers() {
    const result = await this.applyYield();
    if (result.applied > 0) {
      this.logger.log(`Caixinhas: rendimento aplicado em ${result.applied} caixinha(s).`);
    }
  }

  /**
   * Aplica o rendimento do **período já fechado** imediatamente anterior a hoje
   * (mês anterior, ou ano anterior quando a taxa é anual).
   *
   * Creditar o período corrente na primeira vez que o cron enxerga a caixinha
   * pagava juros por tempo que ainda não passou: uma caixinha criada em 31/12
   * com 10% ao ano recebia os 10% cheios em 01/01, e uma mensal criada no dia
   * 30 recebia dois meses de juros em dois dias. Fechar o período resolve o
   * "ainda não passou"; o pró-rata por dias de existência resolve o "existiu só
   * um pedaço dele".
   *
   * Sem `userId`, roda para todos (cron); com `userId`, só dele (endpoint manual).
   */
  async applyYield(userId?: string): Promise<{ applied: number }> {
    const today = todaySaoPaulo();
    const boxes = await this.prisma.savingsBox.findMany({
      where: {
        yieldRate: { not: null },
        yieldPeriod: { not: null },
        ...(userId ? { userId } : {}),
      },
      include: { contributions: true },
    });

    let applied = 0;
    for (const box of boxes) {
      if (!box.yieldRate) continue;

      const monthly = box.yieldPeriod === 'monthly';
      const period = monthly ? previousMonth(today) : previousYear(today);
      const competence = monthly ? competenceOf(period.start) : String(period.start.year);

      const createdOn = calendarDayFromUtcDate(box.createdAt);
      // Caixinha criada depois do fim do período não rendeu nada nele.
      if (toUtcMillis(createdOn) > toUtcMillis(period.end)) continue;

      // Só conta o que já estava guardado quando o período fechou — um aporte
      // feito depois não pode render retroativamente.
      const periodEndMillis = toUtcMillis(period.end);
      const saved = box.contributions
        .filter((c) => c.contributedAt.getTime() <= periodEndMillis)
        .reduce((sum, c) => sum + Number(c.amount), 0);
      if (saved <= 0) continue;

      // Pró-rata: fração do período em que a caixinha existiu.
      const periodDays = daysInclusive(period.start, period.end);
      const accruingFrom =
        toUtcMillis(createdOn) > toUtcMillis(period.start) ? createdOn : period.start;
      const accruingDays = daysInclusive(accruingFrom, period.end);
      const yieldAmount = saved * (Number(box.yieldRate) / 100) * (accruingDays / periodDays);
      if (yieldAmount <= 0) continue;

      const partial =
        accruingDays < periodDays ? ` — proporcional a ${accruingDays}/${periodDays} dias` : '';
      try {
        await this.prisma.savingsContribution.create({
          data: {
            savingsBoxId: box.id,
            amount: yieldAmount,
            // Creditado no dia em que o período fechou, não no dia em que o
            // cron rodou — senão um backfill lançaria o juro com data errada.
            contributedAt: parseDateOnly(dateOnlyString(period.end)),
            note: `Rendimento ${competence} (${box.yieldRate}% ${monthly ? 'ao mês' : 'ao ano'})${partial}`,
            yieldCompetence: competence,
          },
        });
        applied += 1;
      } catch (error) {
        // Já aplicado nesse período (corrida do cron / chamada manual duplicada) — idempotente, ignora.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          continue;
        }
        throw error;
      }
    }
    return { applied };
  }

  private async findOwned(userId: string, id: string) {
    const box = await this.prisma.savingsBox.findUnique({ where: { id } });
    if (!box) throw new NotFoundException('Caixinha não encontrada');
    if (box.userId !== userId) throw new NotFoundException('Caixinha não encontrada');
    return box;
  }
}

function todayIso(): string {
  return dateOnlyString(todaySaoPaulo());
}

/** Instante de referência (meio-dia UTC) de um dia-calendário, para comparar datas. */
function toUtcMillis(day: CalendarDay): number {
  return Date.UTC(day.year, day.monthIndex, day.day, 12, 0, 0);
}

/** Quantidade de dias no intervalo `[from, to]`, incluindo as duas pontas. */
function daysInclusive(from: CalendarDay, to: CalendarDay): number {
  return Math.round((toUtcMillis(to) - toUtcMillis(from)) / 86_400_000) + 1;
}

/** Primeiro e último dia do mês anterior ao dia informado. */
function previousMonth(today: CalendarDay): { start: CalendarDay; end: CalendarDay } {
  const start = new Date(Date.UTC(today.year, today.monthIndex - 1, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return {
    start: { year: start.getUTCFullYear(), monthIndex: start.getUTCMonth(), day: 1 },
    end: { year: end.getUTCFullYear(), monthIndex: end.getUTCMonth(), day: end.getUTCDate() },
  };
}

/** Primeiro e último dia do ano anterior ao dia informado. */
function previousYear(today: CalendarDay): { start: CalendarDay; end: CalendarDay } {
  const year = today.year - 1;
  return {
    start: { year, monthIndex: 0, day: 1 },
    end: { year, monthIndex: 11, day: 31 },
  };
}

/** Competência `"YYYY-MM"` de um dia-calendário. */
function competenceOf(day: CalendarDay): string {
  return `${day.year}-${String(day.monthIndex + 1).padStart(2, '0')}`;
}
