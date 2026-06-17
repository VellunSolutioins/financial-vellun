import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
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
      status, source, search, page = 1, limit = 20,
      sortBy = 'transactionDate', order = 'desc',
    } = filters;

    const where: Prisma.TransactionWhereInput = {
      userId,
      ...(type && { type }),
      ...(categoryId && { categoryId }),
      ...(accountId && { accountId }),
      ...(status && { status }),
      ...(source && { source }),
      ...(search && { description: { contains: search, mode: 'insensitive' } }),
      ...(periodStart || periodEnd
        ? {
            transactionDate: {
              ...(periodStart && { gte: new Date(periodStart) }),
              ...(periodEnd && { lte: new Date(periodEnd) }),
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
        include: { category: true, account: true },
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
      include: { category: true, account: true },
    });
    if (!transaction) throw new NotFoundException('Lançamento não encontrado');
    if (transaction.userId !== userId) throw new ForbiddenException();
    return transaction;
  }

  async create(userId: string, dto: CreateTransactionDto) {
    await this.validateOwnership(userId, dto.accountId, dto.categoryId);

    const transaction = await this.prisma.transaction.create({
      data: {
        userId,
        accountId: dto.accountId,
        categoryId: dto.categoryId,
        type: dto.type,
        amount: dto.amount,
        description: dto.description,
        transactionDate: new Date(dto.transactionDate),
        status: dto.status ?? 'confirmed',
        source: 'manual',
      },
      include: { category: true, account: true },
    });

    if (transaction.status === 'confirmed') {
      await this.accountsService.recalculateBalance(dto.accountId);
    }

    return transaction;
  }

  async update(userId: string, id: string, dto: UpdateTransactionDto) {
    const existing = await this.findOne(userId, id);

    if (dto.categoryId) await this.validateOwnership(userId, undefined, dto.categoryId);

    const transaction = await this.prisma.transaction.update({
      where: { id },
      data: {
        ...dto,
        transactionDate: dto.transactionDate ? new Date(dto.transactionDate) : undefined,
      },
      include: { category: true, account: true },
    });

    await this.accountsService.recalculateBalance(existing.accountId);

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
    if (accountId) {
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
