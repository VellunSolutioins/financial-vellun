import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { startOfMonthUtc, endOfMonthUtc } from '../common/date.util';

import { CreateSpendingGoalDto } from './dto/create-spending-goal.dto';
import { UpdateSpendingGoalDto } from './dto/update-spending-goal.dto';

/** Faixas de comprometimento da meta de gasto por categoria (doc "Metas de Gastos"). */
const HEALTH_BANDS = [
  { max: 40, key: 'excelente', label: 'Excelente' },
  { max: 50, key: 'saudavel', label: 'Saudável' },
  { max: 60, key: 'atencao', label: 'Atenção' },
  { max: 70, key: 'apertado', label: 'Apertado' },
] as const;

function healthFromPercentage(percentage: number): { key: string; label: string } {
  for (const band of HEALTH_BANDS) {
    if (percentage <= band.max) return { key: band.key, label: band.label };
  }
  return { key: 'critico', label: 'Crítico' };
}

@Injectable()
export class SpendingGoalsService {
  constructor(private prisma: PrismaService) {}

  private currentMonthRange() {
    const now = new Date();
    return {
      start: startOfMonthUtc(now.getFullYear(), now.getMonth()),
      end: endOfMonthUtc(now.getFullYear(), now.getMonth()),
    };
  }

  private async spentByCategory(userId: string, categoryIds: string[]) {
    if (categoryIds.length === 0) return new Map<string, number>();
    const { start, end } = this.currentMonthRange();
    const spent = await this.prisma.transaction.groupBy({
      by: ['categoryId'],
      where: {
        userId,
        type: 'expense',
        status: 'confirmed',
        categoryId: { in: categoryIds },
        transactionDate: { gte: start, lte: end },
      },
      _sum: { amount: true },
    });
    return new Map(spent.map((s) => [s.categoryId as string, Number(s._sum.amount ?? 0)]));
  }

  async findAll(userId: string) {
    const goals = await this.prisma.spendingGoal.findMany({
      where: { userId },
      include: { category: true },
      orderBy: { createdAt: 'asc' },
    });

    const spentMap = await this.spentByCategory(
      userId,
      goals.map((g) => g.categoryId),
    );

    return goals.map((goal) => {
      const amount = Number(goal.amount);
      const spent = spentMap.get(goal.categoryId) ?? 0;
      const percentage = amount > 0 ? (spent / amount) * 100 : 0;
      return {
        id: goal.id,
        categoryId: goal.categoryId,
        category: goal.category,
        amount,
        spent,
        percentage,
        health: healthFromPercentage(percentage),
      };
    });
  }

  async summary(userId: string) {
    const goals = await this.prisma.spendingGoal.findMany({ where: { userId } });
    const budget = goals.reduce((sum, g) => sum + Number(g.amount), 0);
    const spentMap = await this.spentByCategory(
      userId,
      goals.map((g) => g.categoryId),
    );
    const spent = goals.reduce((sum, g) => sum + (spentMap.get(g.categoryId) ?? 0), 0);
    const percentage = budget > 0 ? (spent / budget) * 100 : 0;

    return { budget, spent, percentage, health: healthFromPercentage(percentage) };
  }

  async create(userId: string, dto: CreateSpendingGoalDto) {
    const category = await this.prisma.category.findUnique({ where: { id: dto.categoryId } });
    if (!category || (category.userId !== null && category.userId !== userId)) {
      throw new BadRequestException('Categoria inválida');
    }
    if (category.type !== 'expense') {
      throw new BadRequestException('Metas só podem ser definidas para categorias de despesa');
    }

    const existing = await this.prisma.spendingGoal.findUnique({
      where: { userId_categoryId: { userId, categoryId: dto.categoryId } },
    });
    if (existing) {
      throw new ConflictException('Já existe uma meta para essa categoria');
    }

    return this.prisma.spendingGoal.create({
      data: { userId, categoryId: dto.categoryId, amount: dto.amount },
      include: { category: true },
    });
  }

  async update(userId: string, id: string, dto: UpdateSpendingGoalDto) {
    const existing = await this.findOwned(userId, id);
    return this.prisma.spendingGoal.update({
      where: { id: existing.id },
      data: { amount: dto.amount },
      include: { category: true },
    });
  }

  async remove(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);
    return this.prisma.spendingGoal.delete({ where: { id: existing.id } });
  }

  private async findOwned(userId: string, id: string) {
    const goal = await this.prisma.spendingGoal.findUnique({ where: { id } });
    if (!goal) throw new NotFoundException('Meta não encontrada');
    if (goal.userId !== userId) throw new NotFoundException('Meta não encontrada');
    return goal;
  }
}
