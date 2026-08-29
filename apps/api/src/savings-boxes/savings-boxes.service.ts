import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { parseDateOnly, todaySaoPaulo } from '../common/date.util';

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

  /** Aplica o rendimento pendente. Sem `userId`, roda para todos (cron); com `userId`, só dele (endpoint manual). */
  async applyYield(userId?: string): Promise<{ applied: number }> {
    const today = todaySaoPaulo();
    const boxes = await this.prisma.savingsBox.findMany({
      where: { yieldRate: { not: null }, yieldPeriod: { not: null }, ...(userId ? { userId } : {}) },
      include: { contributions: true },
    });

    let applied = 0;
    for (const box of boxes) {
      const competence =
        box.yieldPeriod === 'monthly'
          ? `${today.year}-${String(today.monthIndex + 1).padStart(2, '0')}`
          : `${today.year}`;

      const saved = box.contributions.reduce((sum, c) => sum + Number(c.amount), 0);
      if (saved <= 0 || !box.yieldRate) continue;

      const yieldAmount = saved * (Number(box.yieldRate) / 100);
      try {
        await this.prisma.savingsContribution.create({
          data: {
            savingsBoxId: box.id,
            amount: yieldAmount,
            contributedAt: parseDateOnly(`${today.year}-${String(today.monthIndex + 1).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`),
            note: `Rendimento (${box.yieldRate}% ${box.yieldPeriod === 'monthly' ? 'ao mês' : 'ao ano'})`,
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
  const { year, monthIndex, day } = todaySaoPaulo();
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
