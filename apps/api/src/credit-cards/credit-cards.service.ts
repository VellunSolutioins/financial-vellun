import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  dateOnlyString,
  parseDateOnly,
  todaySaoPaulo,
  startOfMonthUtc,
  endOfMonthUtc,
} from '../common/date.util';

import { healthFromPercentage, incomeHealthFromPercentage } from './card-health';
import { CreateCreditCardDto } from './dto/create-credit-card.dto';
import { UpdateCreditCardDto } from './dto/update-credit-card.dto';

type CardWithAccount = Prisma.CreditCardGetPayload<{ include: { account: true } }>;

/**
 * Cartão em configuração pendente: sem fechamento, vencimento ou início do
 * controle. Cartões legados ficam assim até o usuário configurá-los — nenhuma
 * data é inventada.
 */
export function cardNeedsSetup(card: {
  closingDay: number | null;
  dueDay: number | null;
  invoiceTrackingStart: Date | null;
}): boolean {
  return card.closingDay === null || card.dueDay === null || card.invoiceTrackingStart === null;
}

@Injectable()
export class CreditCardsService {
  constructor(private prisma: PrismaService) {}

  private toCardView(card: CardWithAccount) {
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
      closingDay: card.closingDay,
      dueDay: card.dueDay,
      invoiceTrackingStart: card.invoiceTrackingStart
        ? card.invoiceTrackingStart.toISOString().slice(0, 10)
        : null,
      paymentAccountId: card.paymentAccountId,
      needsSetup: cardNeedsSetup(card),
      isActive: card.account.isActive,
      isPrimary: card.isPrimary,
      currentInvoice,
      available,
      percentage,
      health: percentage !== null ? healthFromPercentage(percentage) : null,
    };
  }

  /** Cartões ativos; com `includeArchived`, também os arquivados (depois dos ativos). */
  async findAll(userId: string, includeArchived = false) {
    const cards = await this.prisma.creditCard.findMany({
      where: { account: { userId, ...(includeArchived ? {} : { isActive: true }) } },
      include: { account: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    return cards
      .map((c) => this.toCardView(c))
      .sort((a, b) => Number(b.isActive) - Number(a.isActive));
  }

  async findOne(userId: string, id: string) {
    return this.toCardView(await this.findOwned(userId, id));
  }

  async summary(userId: string) {
    const cards = await this.findAll(userId);
    const totalCommitted = cards.reduce((sum, c) => sum + c.currentInvoice, 0);
    const totalLimit = cards.reduce((sum, c) => sum + (c.creditLimit ?? 0), 0);

    const today = todaySaoPaulo();
    const income = await this.prisma.transaction.aggregate({
      where: {
        userId,
        type: 'income',
        recurrenceType: 'fixo',
        status: { not: 'cancelled' },
        transactionDate: {
          gte: startOfMonthUtc(today.year, today.monthIndex),
          lte: endOfMonthUtc(today.year, today.monthIndex),
        },
      },
      _sum: { amount: true },
    });
    const monthlyIncome = Number(income._sum.amount ?? 0);
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

  /**
   * Conta interna e cartão nascem na mesma transação de banco: uma falha no
   * cartão não deixa uma conta `credit_card` órfã para trás. O controle de
   * faturas de um cartão novo começa no dia da criação.
   */
  async create(userId: string, dto: CreateCreditCardDto) {
    await this.assertIndividual(userId);
    if (dto.paymentAccountId) await this.assertPaymentAccount(userId, dto.paymentAccountId);

    const card = await this.prisma.$transaction(async (tx) => {
      const existingCount = await tx.creditCard.count({
        where: { account: { userId, isActive: true } },
      });
      const account = await tx.account.create({
        data: { userId, name: dto.name, type: 'credit_card', initialBalance: 0, currentBalance: 0 },
      });
      return tx.creditCard.create({
        data: {
          accountId: account.id,
          brand: dto.brand ?? null,
          color: dto.color ?? null,
          creditLimit: dto.creditLimit ?? null,
          closingDay: dto.closingDay,
          dueDay: dto.dueDay,
          invoiceTrackingStart: parseDateOnly(dateOnlyString(todaySaoPaulo())),
          paymentAccountId: dto.paymentAccountId ?? null,
          isPrimary: existingCount === 0,
        },
        include: { account: true },
      });
    });
    return this.toCardView(card);
  }

  async update(userId: string, id: string, dto: UpdateCreditCardDto) {
    const existing = await this.findOwned(userId, id);
    if ((dto.closingDay !== undefined || dto.dueDay !== undefined) && cardNeedsSetup(existing)) {
      throw new ConflictException(
        'Este cartão está com a configuração pendente. Configure o fechamento antes de alterar as datas.',
      );
    }
    if (dto.paymentAccountId) await this.assertPaymentAccount(userId, dto.paymentAccountId);

    const card = await this.prisma.$transaction(async (tx) => {
      if (dto.name !== undefined) {
        await tx.account.update({ where: { id: existing.accountId }, data: { name: dto.name } });
      }
      return tx.creditCard.update({
        where: { id: existing.id },
        data: {
          ...(dto.brand !== undefined && { brand: dto.brand }),
          ...(dto.color !== undefined && { color: dto.color }),
          ...(dto.creditLimit !== undefined && { creditLimit: dto.creditLimit }),
          ...(dto.closingDay !== undefined && { closingDay: dto.closingDay }),
          ...(dto.dueDay !== undefined && { dueDay: dto.dueDay }),
          ...(dto.paymentAccountId !== undefined && { paymentAccountId: dto.paymentAccountId }),
        },
        include: { account: true },
      });
    });
    return this.toCardView(card);
  }

  async setPrimary(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);
    if (!existing.account.isActive) {
      throw new ConflictException('Cartão arquivado não pode ser o principal');
    }
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

  /**
   * Arquiva o cartão. Cartão em uso tem lançamentos por definição — por isso
   * não passa pela regra de `AccountsService.deactivate` (desenhada para conta
   * comum, que recusa desativar conta com lançamentos). Arquivado, o cartão não
   * recebe compras, mas o histórico continua consultável.
   */
  async remove(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id: existing.accountId }, data: { isActive: false } });
      await tx.creditCard.update({ where: { id: existing.id }, data: { isPrimary: false } });

      if (existing.isPrimary) {
        const nextPrimary = await tx.creditCard.findFirst({
          where: { account: { userId, isActive: true } },
          orderBy: { createdAt: 'asc' },
        });
        if (nextPrimary) {
          await tx.creditCard.update({ where: { id: nextPrimary.id }, data: { isPrimary: true } });
        }
      }
    });
    return { success: true };
  }

  private async findOwned(userId: string, id: string) {
    const card = await this.prisma.creditCard.findUnique({
      where: { id },
      include: { account: true },
    });
    if (!card || card.account.userId !== userId)
      throw new NotFoundException('Cartão não encontrado');
    return card;
  }

  /** Cartões existem só no perfil pessoal. */
  private async assertIndividual(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { profileType: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    if (user.profileType !== 'individual') {
      throw new ForbiddenException('Cartões de crédito estão disponíveis apenas no perfil pessoal');
    }
  }

  /** A conta de pagamento sugerida precisa ser uma conta comum ativa do usuário. */
  private async assertPaymentAccount(userId: string, accountId: string) {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (
      !account ||
      account.userId !== userId ||
      !account.isActive ||
      account.type === 'credit_card'
    ) {
      throw new BadRequestException('Conta de pagamento inválida');
    }
  }
}
