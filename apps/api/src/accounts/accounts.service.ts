import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@Injectable()
export class AccountsService {
  constructor(private prisma: PrismaService) {}

  async findAll(userId: string) {
    return this.prisma.account.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findOne(userId: string, id: string) {
    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) throw new NotFoundException('Conta não encontrada');
    if (account.userId !== userId) throw new ForbiddenException();
    return account;
  }

  async create(userId: string, dto: CreateAccountDto) {
    const initialBalance = dto.initialBalance ?? 0;
    return this.prisma.account.create({
      data: {
        userId,
        name: dto.name,
        type: dto.type,
        initialBalance,
        currentBalance: initialBalance,
        currency: dto.currency ?? 'BRL',
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateAccountDto) {
    const account = await this.findOne(userId, id);
    return this.prisma.account.update({ where: { id: account.id }, data: dto });
  }

  async deactivate(userId: string, id: string) {
    const account = await this.findOne(userId, id);

    const hasTransactions = await this.prisma.transaction.count({
      where: { accountId: id, status: { not: 'cancelled' } },
    });
    if (hasTransactions > 0) {
      throw new BadRequestException(
        'Conta possui lançamentos vinculados. Cancele-os antes de desativar a conta.',
      );
    }

    return this.prisma.account.update({ where: { id: account.id }, data: { isActive: false } });
  }

  async recalculateBalance(accountId: string) {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!account) return;

    const [income, expense] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { accountId, type: 'income', status: 'confirmed' },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { accountId, type: 'expense', status: 'confirmed' },
        _sum: { amount: true },
      }),
    ]);

    const totalIncome = Number(income._sum.amount ?? 0);
    const totalExpense = Number(expense._sum.amount ?? 0);
    const currentBalance = Number(account.initialBalance) + totalIncome - totalExpense;

    await this.prisma.account.update({
      where: { id: accountId },
      data: { currentBalance },
    });
  }
}
