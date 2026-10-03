import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { dateOnlyString, endOfDayUtc, todaySaoPaulo } from '../common/date.util';
import { Db, cents, lockAccounts } from '../common/db';
import { REGULAR_ACCOUNT_WHERE } from './account-types';
import { clearPreferredAccount } from '../financial-resources/preferred-account';
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
    // Dívida de um empréstimo que já existia: saldo inicial negativo.
    const initialBalance =
      dto.type === 'loan' && dto.initialDebt ? -dto.initialDebt : (dto.initialBalance ?? 0);
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

    const [deactivated] = await this.prisma.$transaction([
      this.prisma.account.update({ where: { id: account.id }, data: { isActive: false } }),
      // Conta desativada não recebe lançamento: deixa de ser a preferencial.
      clearPreferredAccount(this.prisma, account.id),
    ]);
    return deactivated;
  }

  /** Qualquer conta do usuário, inclusive a interna de um cartão. */
  async findOwned(userId: string, id: string) {
    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) throw new NotFoundException('Conta não encontrada');
    if (account.userId !== userId) throw new ForbiddenException();
    return account;
  }

  /**
   * Recompõe o saldo gravado (`currentBalance`) do zero. Idempotente.
   *
   * **Conta comum:** inicial + liquidações de pagamento ativas (receita e
   * estorno entram, despesa sai) + pernas de transferência (entrada − saída).
   * Nenhuma data entra na conta: só o que de fato se moveu. Uma despesa
   * vencida e não paga não mexe no saldo; uma receita prevista também não
   * (docs/adrs/0018). Transferência antiga, sem direção, fica de fora.
   *
   * **Conta interna de cartão:** não é saldo, é a posição do cartão — usada só
   * internamente (a interface lê as faturas). Cobranças efetivas (data do fato
   * até hoje) saem, estornos e pagamentos entram.
   *
   * Com `db` = o `tx` de uma transação, roda nela e trava a conta antes de
   * ler: duas escritas na mesma conta não se sobrepõem.
   */
  async recalculateBalance(accountId: string, db: Db = this.prisma) {
    await lockAccounts(db, [accountId]);
    const account = await db.account.findUnique({ where: { id: accountId } });
    if (!account) return;

    const movementCents =
      account.type === 'credit_card'
        ? await this.cardPositionCents(db, accountId)
        : (await this.settledCents(db, accountId)) + (await this.transferCents(db, accountId));
    const currentBalance = (cents(account.initialBalance) + movementCents) / 100;

    await db.account.update({ where: { id: accountId }, data: { currentBalance } });
    return currentBalance;
  }

  /**
   * Saldo que a regra atual daria, sem gravar. Usado pela verificação de
   * consistência e pelo `db:verify:financial-model`.
   */
  async computeBalance(accountId: string, db: Db = this.prisma): Promise<number | null> {
    const account = await db.account.findUnique({ where: { id: accountId } });
    if (!account) return null;
    const movementCents =
      account.type === 'credit_card'
        ? await this.cardPositionCents(db, accountId)
        : (await this.settledCents(db, accountId)) + (await this.transferCents(db, accountId));
    return (cents(account.initialBalance) + movementCents) / 100;
  }

  /** Liquidações de pagamento ativas que passaram por esta conta, com sinal. */
  private async settledCents(db: Db, accountId: string): Promise<number> {
    const [row] = await db.$queryRaw<{ total: string | null }[]>`
      SELECT SUM(CASE WHEN t."type" = 'expense' THEN -s."amount" ELSE s."amount" END)::text AS total
        FROM "transaction_settlements" s
        JOIN "transactions" t ON t."id" = s."transaction_id"
       WHERE s."account_id" = ${accountId}
         AND s."status" = 'active'
         AND s."kind" = 'payment'
         AND t."status" = 'confirmed'
         AND t."type" IN ('income', 'expense', 'refund')
    `;
    return cents(row?.total ?? 0);
  }

  /** Pernas de transferência (pagamento de fatura e entre contas próprias). */
  private async transferCents(db: Db, accountId: string): Promise<number> {
    const legs = await db.transaction.groupBy({
      by: ['transferDirection'],
      where: { accountId, type: 'transfer', status: 'confirmed', transferDirection: { not: null } },
      _sum: { amount: true },
    });
    return legs.reduce(
      (total, leg) => total + (leg.transferDirection === 'in' ? 1 : -1) * cents(leg._sum.amount),
      0,
    );
  }

  /** Posição da conta interna do cartão: só cobranças efetivas (fato até hoje). */
  private async cardPositionCents(db: Db, accountId: string): Promise<number> {
    const upToToday = { lte: endOfDayUtc(dateOnlyString(todaySaoPaulo())) };
    const [entries, legs] = await Promise.all([
      db.transaction.groupBy({
        by: ['type'],
        where: {
          accountId,
          status: 'confirmed',
          type: { in: ['expense', 'refund', 'opening_debt', 'opening_credit'] },
          eventDate: upToToday,
        },
        _sum: { amount: true },
      }),
      this.transferCents(db, accountId),
    ]);
    return entries.reduce(
      (total, row) =>
        total +
        (row.type === 'expense' || row.type === 'opening_debt' ? -1 : 1) * cents(row._sum.amount),
      legs,
    );
  }
}

function assertRegular(account: { type?: string }) {
  if (account.type === 'credit_card') throw new ConflictException(CARD_ACCOUNT_MESSAGE);
}
