import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';

import { CreateCreditCardDto } from './dto/create-credit-card.dto';
import { UpdateCreditCardDto } from './dto/update-credit-card.dto';

/** Selos de comprometimento do limite (só aplicável quando há creditLimit). */
const HEALTH_BANDS = [
  { max: 20, key: 'tranquilo', emoji: '🟢', label: 'Tranquilo', message: 'Você está usando pouco do seu limite.' },
  { max: 40, key: 'saudavel', emoji: '🔵', label: 'Saudável', message: 'Boa margem disponível para seus gastos.' },
  { max: 60, key: 'atencao', emoji: '🟡', label: 'Atenção', message: 'Seu limite já está parcialmente comprometido.' },
  { max: 80, key: 'apertado', emoji: '🟠', label: 'Apertado', message: 'Fique de olho nos próximos gastos.' },
  { max: 99, key: 'no_limite', emoji: '🔴', label: 'No Limite', message: 'Seu limite está quase comprometido.' },
] as const;

function healthFromPercentage(percentage: number): {
  key: string;
  emoji: string;
  label: string;
  message: string;
} {
  for (const band of HEALTH_BANDS) {
    if (percentage <= band.max) return band;
  }
  return {
    key: 'limite_atingido',
    emoji: '🚨',
    label: 'Limite Atingido',
    message: 'Seu limite foi alcançado. Evite novos gastos até liberar crédito.',
  };
}

/** Selos de comprometimento da fatura total em relação à renda mensal fixa (RecurringRule income). */
const INCOME_HEALTH_BANDS = [
  { max: 10, key: 'excelente', emoji: '🟢', label: 'Excelente' },
  { max: 20, key: 'saudavel', emoji: '🔵', label: 'Saudável' },
  { max: 30, key: 'atencao', emoji: '🟡', label: 'Atenção' },
  { max: 40, key: 'apertado', emoji: '🟠', label: 'Apertado' },
  { max: 50, key: 'critico', emoji: '🔴', label: 'Crítico' },
] as const;

function incomeHealthFromPercentage(percentage: number): { key: string; emoji: string; label: string } {
  for (const band of INCOME_HEALTH_BANDS) {
    if (percentage <= band.max) return band;
  }
  return { key: 'muito_alto', emoji: '🚨', label: 'Muito Alto' };
}

@Injectable()
export class CreditCardsService {
  constructor(
    private prisma: PrismaService,
    private accountsService: AccountsService,
  ) {}

  private toCardView(card: {
    id: string;
    brand: string | null;
    color: string | null;
    creditLimit: import('@prisma/client').Prisma.Decimal | null;
    dueDay: number;
    isPrimary: boolean;
    createdAt: Date;
    updatedAt: Date;
    account: { id: string; name: string; currentBalance: import('@prisma/client').Prisma.Decimal };
  }) {
    const creditLimit = card.creditLimit ? Number(card.creditLimit) : null;
    const currentInvoice = Math.max(0, -Number(card.account.currentBalance));
    const available = creditLimit !== null ? Math.max(0, creditLimit - currentInvoice) : null;
    const percentage = creditLimit ? (currentInvoice / creditLimit) * 100 : null;
    return {
      id: card.id,
      accountId: card.account.id,
      name: card.account.name,
      brand: card.brand,
      color: card.color,
      creditLimit,
      dueDay: card.dueDay,
      isPrimary: card.isPrimary,
      currentInvoice,
      available,
      percentage,
      health: percentage !== null ? healthFromPercentage(percentage) : null,
    };
  }

  async findAll(userId: string) {
    const cards = await this.prisma.creditCard.findMany({
      where: { account: { userId, isActive: true } },
      include: { account: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    return cards.map((c) => this.toCardView(c));
  }

  async summary(userId: string) {
    const cards = await this.findAll(userId);
    const totalCommitted = cards.reduce((sum, c) => sum + c.currentInvoice, 0);
    const totalLimit = cards.reduce((sum, c) => sum + (c.creditLimit ?? 0), 0);

    const incomeAgg = await this.prisma.recurringRule.aggregate({
      where: { userId, type: 'income', isActive: true },
      _sum: { amount: true },
    });
    const monthlyIncome = Number(incomeAgg._sum.amount ?? 0);
    const incomePercentage = monthlyIncome > 0 ? (totalCommitted / monthlyIncome) * 100 : null;

    return {
      totalCommitted,
      totalLimit,
      cardCount: cards.length,
      monthlyIncome,
      incomePercentage,
      incomeHealth: incomePercentage !== null ? incomeHealthFromPercentage(incomePercentage) : null,
    };
  }

  async create(userId: string, dto: CreateCreditCardDto) {
    const existingCount = await this.prisma.creditCard.count({
      where: { account: { userId, isActive: true } },
    });

    const account = await this.accountsService.create(userId, {
      name: dto.name,
      type: 'credit_card',
      initialBalance: 0,
    });

    const card = await this.prisma.creditCard.create({
      data: {
        accountId: account.id,
        brand: dto.brand ?? null,
        color: dto.color ?? null,
        creditLimit: dto.creditLimit ?? null,
        dueDay: dto.dueDay,
        isPrimary: existingCount === 0,
      },
      include: { account: true },
    });
    return this.toCardView(card);
  }

  async update(userId: string, id: string, dto: UpdateCreditCardDto) {
    const existing = await this.findOwned(userId, id);
    if (dto.name !== undefined) {
      await this.accountsService.update(userId, existing.accountId, { name: dto.name });
    }
    const card = await this.prisma.creditCard.update({
      where: { id: existing.id },
      data: {
        ...(dto.brand !== undefined && { brand: dto.brand }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.creditLimit !== undefined && { creditLimit: dto.creditLimit }),
        ...(dto.dueDay !== undefined && { dueDay: dto.dueDay }),
      },
      include: { account: true },
    });
    return this.toCardView(card);
  }

  async setPrimary(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);
    await this.prisma.$transaction([
      this.prisma.creditCard.updateMany({
        where: { account: { userId, isActive: true } },
        data: { isPrimary: false },
      }),
      this.prisma.creditCard.update({ where: { id: existing.id }, data: { isPrimary: true } }),
    ]);
    const card = await this.prisma.creditCard.findUniqueOrThrow({
      where: { id: existing.id },
      include: { account: true },
    });
    return this.toCardView(card);
  }

  async remove(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);

    // Cartão em uso tem lançamentos por definição — arquivar direto, sem passar
    // pela regra de accountsService.deactivate (desenhada para conta corrente,
    // que recusa desativar contas com lançamentos vinculados).
    await this.prisma.account.update({
      where: { id: existing.accountId },
      data: { isActive: false },
    });

    await this.prisma.creditCard.update({
      where: { id: existing.id },
      data: { isPrimary: false },
    });

    if (existing.isPrimary) {
      const nextPrimary = await this.prisma.creditCard.findFirst({
        where: { account: { userId, isActive: true } },
        orderBy: { createdAt: 'asc' },
      });
      if (nextPrimary) {
        await this.prisma.creditCard.update({ where: { id: nextPrimary.id }, data: { isPrimary: true } });
      }
    }
    return { success: true };
  }

  private async findOwned(userId: string, id: string) {
    const card = await this.prisma.creditCard.findUnique({ where: { id }, include: { account: true } });
    if (!card || card.account.userId !== userId) throw new NotFoundException('Cartão não encontrado');
    return card;
  }
}
