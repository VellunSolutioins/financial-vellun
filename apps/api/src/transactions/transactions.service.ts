import { randomUUID } from 'crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { parseDateOnly, startOfDayUtc, endOfDayUtc, addMonthsUtc } from '../common/date.util';

import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';

@Injectable()
export class TransactionsService {
  constructor(
    private prisma: PrismaService,
    private accountsService: AccountsService,
  ) {}

  async findAll(userId: string, filters: ListTransactionsDto) {
    const {
      periodStart, periodEnd, type, categoryId, accountId,
      status, source, search, authorId, page = 1, limit = 20,
      sortBy = 'transactionDate', order = 'desc',
    } = filters;

    const where: Prisma.TransactionWhereInput = {
      userId,
      ...(type && { type }),
      ...(categoryId === 'uncategorized' ? { categoryId: null } : categoryId ? { categoryId } : {}),
      ...(accountId && { accountId }),
      ...(status && { status }),
      ...(source && { source }),
      ...(authorId && { createdByUserId: authorId }),
      ...(search && { description: { contains: search, mode: 'insensitive' } }),
      ...(periodStart || periodEnd
        ? {
            transactionDate: {
              ...(periodStart && { gte: startOfDayUtc(periodStart) }),
              ...(periodEnd && { lte: endOfDayUtc(periodEnd) }),
            },
          }
        : {}),
    };

    const validSortFields: Record<string, string> = {
      transactionDate: 'transactionDate',
      amount: 'amount',
      description: 'description',
      createdAt: 'createdAt',
    };
    const orderByField = validSortFields[sortBy] ?? 'transactionDate';

    const [data, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        include: {
          category: true,
          account: true,
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { [orderByField]: order },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(userId: string, id: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
      include: {
        category: true,
        account: true,
        createdBy: { select: { id: true, name: true } },
      },
    });
    if (!transaction) throw new NotFoundException('Lançamento não encontrado');
    if (transaction.userId !== userId) throw new ForbiddenException();
    return transaction;
  }

  async create(userId: string, createdByUserId: string, dto: CreateTransactionDto) {
    await this.validateOwnership(userId, dto.accountId, dto.categoryId);

    const recurrenceType = dto.recurrenceType ?? 'avulso';
    const firstDate = parseDateOnly(dto.transactionDate);
    const baseData = {
      userId,
      createdByUserId,
      accountId: dto.accountId,
      categoryId: dto.categoryId || null,
      type: dto.type,
      amount: dto.amount,
      description: dto.description,
      source: 'manual' as const,
      recurrenceType,
    };

    let occurrences: number;
    if (recurrenceType === 'parcelado') {
      if (!dto.installments || dto.installments < 2 || dto.installments > 72) {
        throw new BadRequestException('Número de parcelas inválido (mínimo 2, máximo 72)');
      }
      occurrences = dto.installments;
    } else if (recurrenceType === 'fixo') {
      if (!dto.recurrenceMonths || dto.recurrenceMonths < 2 || dto.recurrenceMonths > 120) {
        throw new BadRequestException('Quantidade de meses inválida (mínimo 2, máximo 120)');
      }
      occurrences = dto.recurrenceMonths;
    } else {
      occurrences = 1;
    }

    const seriesId = occurrences > 1 ? randomUUID() : null;

    // Em "parcelado" o usuário informa o valor TOTAL da compra e o backend
    // divide; em "fixo" o valor é o de cada ocorrência (uma mensalidade de
    // R$ 200 por 12 meses são 12 lançamentos de R$ 200, não de R$ 16,67).
    const amountFor =
      recurrenceType === 'parcelado'
        ? installmentAmounts(dto.amount, occurrences)
        : () => dto.amount;

    const [firstTransaction] = await this.prisma.$transaction(
      Array.from({ length: occurrences }, (_, i) =>
        this.prisma.transaction.create({
          data: {
            ...baseData,
            amount: amountFor(i),
            transactionDate: i === 0 ? firstDate : addMonthsUtc(firstDate, i),
            // A primeira ocorrência respeita o status escolhido; as futuras
            // nascem pendentes, já que ainda não aconteceram.
            status: i === 0 ? (dto.status ?? 'confirmed') : 'pending',
            seriesId,
            installmentNumber: seriesId ? i + 1 : null,
            installmentTotal: seriesId ? occurrences : null,
          },
          include: {
            category: true,
            account: true,
            createdBy: { select: { id: true, name: true } },
          },
        }),
      ),
    );

    await this.accountsService.recalculateBalance(dto.accountId);

    return firstTransaction;
  }

  async update(userId: string, id: string, dto: UpdateTransactionDto) {
    const existing = await this.findOne(userId, id);

    if (dto.accountId !== undefined || dto.categoryId !== undefined) {
      await this.validateOwnership(userId, dto.accountId, dto.categoryId);
    }

    const categoryId = dto.categoryId === '' ? null : dto.categoryId;

    const transaction = await this.prisma.transaction.update({
      where: { id },
      data: {
        ...dto,
        categoryId,
        transactionDate: dto.transactionDate ? parseDateOnly(dto.transactionDate) : undefined,
      },
      include: {
        category: true,
        account: true,
        createdBy: { select: { id: true, name: true } },
      },
    });

    await this.accountsService.recalculateBalance(existing.accountId);
    if (transaction.accountId !== existing.accountId) {
      await this.accountsService.recalculateBalance(transaction.accountId);
    }

    return transaction;
  }

  async remove(userId: string, id: string, hardDelete = false) {
    const transaction = await this.findOne(userId, id);

    if (hardDelete) {
      await this.prisma.transaction.delete({ where: { id } });
    } else {
      await this.prisma.transaction.update({
        where: { id },
        data: { status: 'cancelled' },
      });
    }

    await this.accountsService.recalculateBalance(transaction.accountId);
    return { message: 'Lançamento removido com sucesso' };
  }

  async findAiAudit(userId: string, id: string) {
    await this.findOne(userId, id);

    const extractions = await this.prisma.aiExtractedTransaction.findMany({
      where: { transactionId: id, userId },
      orderBy: { createdAt: 'desc' },
    });

    if (extractions.length === 0) {
      throw new NotFoundException('Nenhuma extração de IA associada a este lançamento');
    }

    return extractions;
  }

  private async validateOwnership(userId: string, accountId?: string, categoryId?: string) {
    if (accountId !== undefined) {
      if (!accountId) throw new BadRequestException('Conta inválida');
      const account = await this.prisma.account.findUnique({ where: { id: accountId } });
      if (!account || account.userId !== userId) {
        throw new BadRequestException('Conta inválida');
      }
    }
    if (categoryId) {
      const category = await this.prisma.category.findUnique({ where: { id: categoryId } });
      if (!category || (category.userId !== null && category.userId !== userId)) {
        throw new BadRequestException('Categoria inválida');
      }
    }
  }
}

/**
 * Reparte um valor total em `count` parcelas de centavos exatos.
 *
 * Dividir e arredondar cada parcela isoladamente perde ou cria centavos
 * (R$ 100,00 em 3x viraria 3 × 33,33 = 99,99). Aqui todas as parcelas ficam com
 * o valor arredondado para baixo e a **última** absorve a sobra, então a soma
 * bate com o total informado até o último centavo.
 */
export function installmentAmounts(total: number, count: number): (index: number) => number {
  const totalCents = Math.round(total * 100);
  const baseCents = Math.floor(totalCents / count);
  const remainderCents = totalCents - baseCents * count;
  return (index) => (index === count - 1 ? baseCents + remainderCents : baseCents) / 100;
}
