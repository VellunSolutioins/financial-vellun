import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { dateOnlyString, endOfDayUtc, todaySaoPaulo } from '../common/date.util';
import { REGULAR_ACCOUNT_WHERE } from './account-types';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

const CARD_ACCOUNT_MESSAGE =
  'Esta conta pertence a um cartão de crédito. Gerencie-a em Cartões (/credit-cards).';

@Injectable()
export class AccountsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Contas comuns ativas. As contas internas dos cartões ficam de fora de
   * propósito — elas só existem para guardar os lançamentos do cartão.
   */
  async findAll(userId: string) {
    return this.prisma.account.findMany({
      where: { userId, isActive: true, ...REGULAR_ACCOUNT_WHERE },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Conta comum do usuário; a conta interna de um cartão responde 409. */
  async findOne(userId: string, id: string) {
    const account = await this.findOwned(userId, id);
    assertRegular(account);
    return account;
  }

  async create(userId: string, dto: CreateAccountDto) {
    // O DTO já recusa `credit_card`; a checagem repete a regra para quem
    // chamar o serviço direto.
    assertRegular(dto);
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
    assertRegular(dto);
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

  /** Qualquer conta do usuário, inclusive a interna de um cartão. */
  async findOwned(userId: string, id: string) {
    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) throw new NotFoundException('Conta não encontrada');
    if (account.userId !== userId) throw new ForbiddenException();
    return account;
  }

  /**
   * Saldo = inicial + receitas − despesas + estornos − transferências que
   * saíram + transferências que entraram, confirmados com data até hoje.
   * Transferência antiga, sem direção, fica de fora como sempre ficou.
   * Lançamento futuro (parcela ou mensalidade dos próximos meses) não entra:
   * ele ainda não aconteceu. Por depender do dia, o saldo também é recomposto
   * pelo `AccountBalanceScheduler` quando um lançamento futuro chega à sua data.
   */
  async recalculateBalance(accountId: string) {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!account) return;

    const upToToday = { lte: endOfDayUtc(dateOnlyString(todaySaoPaulo())) };
    const sums = await this.prisma.transaction.groupBy({
      by: ['type', 'transferDirection'],
      where: { accountId, status: 'confirmed', transactionDate: upToToday },
      _sum: { amount: true },
    });
    const sign = (row: (typeof sums)[number]) => {
      if (row.type === 'income' || row.type === 'refund') return 1;
      if (row.type === 'expense') return -1;
      if (row.type === 'transfer' && row.transferDirection === 'in') return 1;
      if (row.type === 'transfer' && row.transferDirection === 'out') return -1;
      return 0;
    };
    const movementCents = sums.reduce(
      (total, row) => total + sign(row) * Math.round(Number(row._sum.amount ?? 0) * 100),
      0,
    );
    const currentBalance = Number(account.initialBalance) + movementCents / 100;

    await this.prisma.account.update({
      where: { id: accountId },
      data: { currentBalance },
    });
  }
}

function assertRegular(account: { type?: string }) {
  if (account.type === 'credit_card') throw new ConflictException(CARD_ACCOUNT_MESSAGE);
}
