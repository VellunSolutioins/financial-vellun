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
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { ListTransactionsDto, TransactionFiltersDto } from './dto/list-transactions.dto';
import { ResourceScope, scopeWhere } from '../common/resource-scope';
import { CardLedgerService } from '../credit-cards/card-ledger.service';
import { parseDateOnly, startOfDayUtc, endOfDayUtc, addMonthsUtc } from '../common/date.util';
import { FREQUENCY_STEP_MONTHS } from './recurrence-frequency';

@Injectable()
export class TransactionsService {
  constructor(
    private prisma: PrismaService,
    private accountsService: AccountsService,
    private resourceScope: ResourceScope = new ResourceScope(prisma),
    private cardLedger: CardLedgerService = new CardLedgerService(prisma),
  ) {}

  /** Filtro comum da listagem e dos totais; valida o recorte por conta/cartão. */
  private async buildWhere(
    userId: string,
    filters: TransactionFiltersDto,
  ): Promise<Prisma.TransactionWhereInput> {
    const {
      periodStart,
      periodEnd,
      type,
      categoryId,
      accountId,
      status,
      source,
      recurrenceType,
      search,
    } = filters;
    const scoped = await this.resourceScope.resolve(userId, filters);

    return {
      userId,
      ...(type && { type }),
      ...(categoryId === 'uncategorized' ? { categoryId: null } : categoryId ? { categoryId } : {}),
      // `accountId` (legado, um só) e o recorte por recursos se somam.
      AND: [accountId ? { accountId } : {}, scopeWhere(scoped)],
      ...(status && { status }),
      ...(source && { source }),
      ...(recurrenceType && { recurrenceType }),
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
  }

  async findAll(userId: string, filters: ListTransactionsDto) {
    const { page = 1, limit = 10, sortBy = 'transactionDate', order = 'desc' } = filters;
    const where = await this.buildWhere(userId, filters);

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

  /**
   * Totais dos lançamentos que a listagem mostraria com os mesmos filtros —
   * todas as páginas, não só a atual. Só confirmados entram na soma: com o
   * filtro `status=cancelled`, os totais são zero.
   */
  async summary(userId: string, filters: TransactionFiltersDto) {
    const where: Prisma.TransactionWhereInput = {
      AND: [
        await this.buildWhere(userId, filters),
        { status: 'confirmed', type: { in: ['income', 'expense'] } },
      ],
    };

    const [byType, byCategory] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['type'],
        where,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['type', 'categoryId'],
        where,
        _sum: { amount: true },
      }),
    ]);

    const totalOf = (type: string) =>
      Number(byType.find((row) => row.type === type)?._sum.amount ?? 0);
    const income = totalOf('income');
    const expense = totalOf('expense');

    const categoryIds = byCategory.map((row) => row.categoryId).filter(Boolean) as string[];
    const categories = await this.prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true, color: true },
    });
    const categoryById = new Map(categories.map((c) => [c.id, c]));

    return {
      income,
      expense,
      net: income - expense,
      count: byType.reduce((sum, row) => sum + row._count._all, 0),
      byCategory: byCategory
        .map((row) => {
          const total = Number(row._sum.amount ?? 0);
          const category = row.categoryId ? categoryById.get(row.categoryId) : undefined;
          const typeTotal = row.type === 'income' ? income : expense;
          return {
            type: row.type as 'income' | 'expense',
            categoryId: row.categoryId,
            categoryName: category?.name ?? 'Sem categoria',
            color: category?.color ?? null,
            total,
            percentage: typeTotal > 0 ? (total / typeTotal) * 100 : 0,
          };
        })
        .sort((a, b) => b.total - a.total),
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

    const recurrenceType = dto.recurrenceType ?? 'avulso';
    const recurrenceFrequency =
      recurrenceType === 'fixo' ? (dto.recurrenceFrequency ?? 'monthly') : null;
    // Parcelas são sempre mensais; o fixo segue a frequência escolhida.
    const stepMonths = recurrenceFrequency ? FREQUENCY_STEP_MONTHS[recurrenceFrequency] : 1;
    const firstDate = parseDateOnly(dto.transactionDate);
    const baseData = {
      userId,
      accountId: dto.accountId,
      categoryId: dto.categoryId || null,
      type: dto.type,
      amount: dto.amount,
      description: dto.description,
      source: 'manual' as const,
      recurrenceType,
      recurrenceFrequency,
    };

    let occurrences: number;
    if (recurrenceType === 'parcelado') {
      if (!dto.installments || dto.installments < 2 || dto.installments > 72) {
        throw new BadRequestException('Número de parcelas inválido (mínimo 2, máximo 72)');
      }
      occurrences = dto.installments;
    } else if (recurrenceType === 'fixo') {
      if (!dto.recurrenceMonths || dto.recurrenceMonths < 2 || dto.recurrenceMonths > 120) {
        throw new BadRequestException('Quantidade de ocorrências inválida (mínimo 2, máximo 120)');
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

    const created = await this.prisma.$transaction(
      Array.from({ length: occurrences }, (_, i) =>
        this.prisma.transaction.create({
          data: {
            ...baseData,
            amount: amountFor(i),
            transactionDate: i === 0 ? firstDate : addMonthsUtc(firstDate, i * stepMonths),
            // Todas nascem confirmadas: as futuras ficam fora do saldo pela data,
            // não por status (ver AccountsService.recalculateBalance).
            status: 'confirmed',
            seriesId,
            installmentNumber: seriesId ? i + 1 : null,
            installmentTotal: seriesId ? occurrences : null,
          },
          include: {
            category: true,
            account: true,
          },
        }),
      ),
    );

    await this.accountsService.recalculateBalance(dto.accountId);
    await this.cardLedger.syncTransactions(created.map((t) => t.id));

    return this.prisma.transaction.findUniqueOrThrow({
      where: { id: created[0].id },
      include: { category: true, account: true },
    });
  }

  async update(userId: string, id: string, dto: UpdateTransactionDto) {
    const existing = await this.findOne(userId, id);

    // A conta só é revalidada quando muda: editar a descrição de um lançamento
    // de cartão arquivado continua permitido.
    const accountChanged = dto.accountId !== undefined && dto.accountId !== existing.accountId;
    if (accountChanged || dto.categoryId !== undefined) {
      await this.validateOwnership(
        userId,
        accountChanged ? dto.accountId : undefined,
        dto.categoryId,
      );
    }

    const categoryId = dto.categoryId === '' ? null : dto.categoryId;

    const transaction = await this.prisma.transaction.update({
      where: { id },
      data: {
        ...dto,
        categoryId,
        transactionDate: dto.transactionDate ? parseDateOnly(dto.transactionDate) : undefined,
      },
      include: { category: true, account: true },
    });

    await this.accountsService.recalculateBalance(existing.accountId);
    if (transaction.accountId !== existing.accountId) {
      await this.accountsService.recalculateBalance(transaction.accountId);
    }
    // Data, valor, conta ou status podem mudar a fatura (ou tirá-la dela).
    await this.cardLedger.syncTransactions([id]);
    await this.cardLedger.pruneForAccount(existing.accountId);

    return { ...transaction, invoiceId: (await this.findOne(userId, id)).invoiceId };
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
      await this.cardLedger.syncTransactions([id]);
    }

    await this.accountsService.recalculateBalance(transaction.accountId);
    await this.cardLedger.pruneForAccount(transaction.accountId);
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

  /**
   * Conta e categoria precisam ser do usuário, e a conta precisa estar ativa —
   * cartão arquivado não recebe compra. Usado também pelas recorrências.
   */
  async validateOwnership(userId: string, accountId?: string, categoryId?: string) {
    if (accountId !== undefined) {
      if (!accountId) throw new BadRequestException('Conta inválida');
      const account = await this.prisma.account.findUnique({ where: { id: accountId } });
      if (!account || account.userId !== userId) {
        throw new BadRequestException('Conta inválida');
      }
      assertAccountAcceptsEntries(account);
    }
    if (categoryId) {
      const category = await this.prisma.category.findUnique({ where: { id: categoryId } });
      if (!category || (category.userId !== null && category.userId !== userId)) {
        throw new BadRequestException('Categoria inválida');
      }
    }
  }
}

/** Conta desativada ou cartão arquivado não recebem lançamento novo. */
export function assertAccountAcceptsEntries(account: { isActive: boolean; type: string }) {
  if (account.isActive) return;
  throw new BadRequestException(
    account.type === 'credit_card'
      ? 'Cartão arquivado não recebe novas compras'
      : 'Conta desativada não recebe novos lançamentos',
  );
}

export function installmentAmounts(total: number, count: number): (index: number) => number {
  const totalCents = Math.round(total * 100);
  const baseCents = Math.floor(totalCents / count);
  const remainderCents = totalCents - baseCents * count;
  return (index) => (index === count - 1 ? baseCents + remainderCents : baseCents) / 100;
}
