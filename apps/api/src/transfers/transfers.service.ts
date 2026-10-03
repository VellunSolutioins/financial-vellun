import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AccountType, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { isFutureDay, parseDateOnly } from '../common/date.util';
import { Db, FINANCIAL_TX_OPTIONS, cents, lockAccounts } from '../common/db';
import { recordSettlement } from '../transactions/settlements.service';
import { CreateTransferDto } from './dto/create-transfer.dto';

/** Tamanho da página (CLAUDE.md: 10 por página). */
const PAGE_SIZE = 10;

export type TransferKind =
  | 'own_transfer'
  | 'investment_contribution'
  | 'investment_withdrawal'
  | 'loan_received'
  | 'loan_payment';

/**
 * O que a transferência representa, pelo tipo das contas. Empréstimo ganha de
 * investimento: amortizar com dinheiro de uma aplicação continua sendo
 * amortização.
 */
export function transferKind(from: AccountType | string, to: AccountType | string): TransferKind {
  if (from === 'loan') return 'loan_received';
  if (to === 'loan') return 'loan_payment';
  if (to === 'investment' && from !== 'investment') return 'investment_contribution';
  if (from === 'investment' && to !== 'investment') return 'investment_withdrawal';
  return 'own_transfer';
}

const KIND_LABEL: Record<TransferKind, string> = {
  own_transfer: 'Transferência entre contas',
  investment_contribution: 'Aporte em investimento',
  investment_withdrawal: 'Resgate de investimento',
  loan_received: 'Empréstimo recebido',
  loan_payment: 'Amortização de empréstimo',
};

const transferInclude = {
  fromAccount: { select: { id: true, name: true, type: true } },
  toAccount: { select: { id: true, name: true, type: true } },
  feeTransaction: { select: { id: true, amount: true, categoryId: true, status: true } },
} satisfies Prisma.AccountTransferInclude;

type TransferRow = Prisma.AccountTransferGetPayload<{ include: typeof transferInclude }>;

function transferView(t: TransferRow, idempotent = false) {
  const kind = transferKind(t.fromAccount.type, t.toAccount.type);
  return {
    id: t.id,
    kind,
    kindLabel: KIND_LABEL[kind],
    fromAccount: t.fromAccount,
    toAccount: t.toAccount,
    amount: Number(t.amount),
    date: t.transferDate.toISOString().slice(0, 10),
    description: t.description,
    fee:
      t.feeTransaction && t.feeTransaction.status === 'confirmed'
        ? { transactionId: t.feeTransaction.id, amount: Number(t.feeTransaction.amount) }
        : null,
    status: t.status,
    reversedAt: t.reversedAt,
    ...(idempotent && { idempotent: true }),
  };
}

/**
 * Movimentações entre contas próprias (docs/adrs/0018): transferência,
 * aporte, resgate, empréstimo recebido e amortização. Duas pernas `transfer`
 * com direção — a soma dos saldos não muda e nada vira receita ou despesa.
 * A conta de empréstimo é passivo: recebê-lo deixa o saldo dela negativo
 * (a dívida) e aumenta o caixa; amortizar reduz os dois. Juros e tarifas são
 * uma despesa à parte, separada do principal.
 *
 * Tudo — transferência, pernas, despesa de juros, saldos — num commit, com
 * as contas travadas em ordem fixa.
 */
@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    private prisma: PrismaService,
    private accountsService: AccountsService,
  ) {}

  async list(userId: string, page = 1) {
    const where = { userId };
    const [rows, total] = await Promise.all([
      this.prisma.accountTransfer.findMany({
        where,
        include: transferInclude,
        orderBy: [{ transferDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.prisma.accountTransfer.count({ where }),
    ]);
    return {
      data: rows.map((r) => transferView(r)),
      meta: { total, page, limit: PAGE_SIZE, totalPages: Math.ceil(total / PAGE_SIZE) },
    };
  }

  async create(userId: string, dto: CreateTransferDto) {
    const existing = await this.findByKey(dto.idempotencyKey, userId);
    if (existing) return existing;

    if (dto.fromAccountId === dto.toAccountId) {
      throw new BadRequestException('Origem e destino precisam ser contas diferentes');
    }
    const date = parseDateOnly(dto.date.slice(0, 10));
    if (isFutureDay(date)) {
      throw new BadRequestException('A data da transferência não pode ser futura');
    }
    const [from, to] = await Promise.all([
      this.ownedRegular(userId, dto.fromAccountId),
      this.ownedRegular(userId, dto.toAccountId),
    ]);
    const kind = transferKind(from.type, to.type);
    // Quem paga os juros é a conta de caixa: no empréstimo recebido, a que
    // recebe o dinheiro; nos outros, a que manda.
    const feeAccount = kind === 'loan_received' ? to : from;
    const feeCategoryId = dto.feeAmount ? await this.feeCategory(userId, dto.feeCategoryId) : null;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await lockAccounts(tx, [from.id, to.id]);
        const transfer = await tx.accountTransfer.create({
          data: {
            userId,
            fromAccountId: from.id,
            toAccountId: to.id,
            amount: dto.amount,
            transferDate: date,
            description: dto.description?.trim() || KIND_LABEL[kind],
            idempotencyKey: dto.idempotencyKey,
          },
        });
        const leg = {
          userId,
          type: 'transfer' as const,
          amount: dto.amount,
          description: transfer.description,
          transactionDate: date,
          eventDate: date,
          status: 'confirmed' as const,
          source: 'manual' as const,
          accountTransferId: transfer.id,
        };
        await tx.transaction.createMany({
          data: [
            { ...leg, accountId: from.id, transferDirection: 'out' },
            { ...leg, accountId: to.id, transferDirection: 'in' },
          ],
        });

        if (dto.feeAmount) {
          const fee = await tx.transaction.create({
            data: {
              userId,
              accountId: feeAccount.id,
              categoryId: feeCategoryId,
              type: 'expense',
              amount: dto.feeAmount,
              description: `Juros/tarifa: ${transfer.description}`,
              transactionDate: date,
              eventDate: date,
              status: 'confirmed',
              source: 'manual',
            },
          });
          await recordSettlement(tx, {
            userId,
            transactionId: fee.id,
            accountId: feeAccount.id,
            amountCents: cents(dto.feeAmount),
            date,
            origin: 'at_sight',
          });
          await tx.accountTransfer.update({
            where: { id: transfer.id },
            data: { feeTransactionId: fee.id },
          });
        }

        await this.accountsService.recalculateBalance(from.id, tx);
        await this.accountsService.recalculateBalance(to.id, tx);
        return tx.accountTransfer.findUniqueOrThrow({
          where: { id: transfer.id },
          include: transferInclude,
        });
      }, FINANCIAL_TX_OPTIONS);
      return transferView(created);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.findByKey(dto.idempotencyKey, userId);
        if (raced) return raced;
      }
      throw err;
    }
  }

  /**
   * Reverter marca a transferência `reversed`, cancela as pernas e desfaz a
   * despesa de juros (reverte o pagamento dela e a cancela). O histórico fica.
   * Idempotente.
   */
  async reverse(userId: string, id: string) {
    const transfer = await this.prisma.accountTransfer.findFirst({ where: { id, userId } });
    if (!transfer) throw new NotFoundException('Transferência não encontrada');

    const reversed = await this.prisma.$transaction(async (tx) => {
      await lockAccounts(tx, [transfer.fromAccountId, transfer.toAccountId]);
      const current = await tx.accountTransfer.findUniqueOrThrow({
        where: { id },
        include: transferInclude,
      });
      if (current.status === 'reversed') return current;

      await tx.accountTransfer.update({
        where: { id },
        data: { status: 'reversed', reversedAt: new Date() },
      });
      await tx.transaction.updateMany({
        where: { accountTransferId: id },
        data: { status: 'cancelled' },
      });
      if (current.feeTransactionId) await this.undoFee(tx, current.feeTransactionId);

      await this.accountsService.recalculateBalance(transfer.fromAccountId, tx);
      await this.accountsService.recalculateBalance(transfer.toAccountId, tx);
      return tx.accountTransfer.findUniqueOrThrow({ where: { id }, include: transferInclude });
    }, FINANCIAL_TX_OPTIONS);
    return transferView(reversed);
  }

  private async undoFee(tx: Db, feeTransactionId: string) {
    await tx.transactionSettlement.updateMany({
      where: { transactionId: feeTransactionId, status: 'active' },
      data: { status: 'reversed', reversedAt: new Date() },
    });
    await tx.transaction.update({
      where: { id: feeTransactionId },
      data: { status: 'cancelled', settledAmount: 0 },
    });
  }

  /** Conta comum (não cartão), ativa e do usuário. */
  private async ownedRegular(userId: string, accountId: string) {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== userId) throw new BadRequestException('Conta inválida');
    if (account.type === 'credit_card') {
      throw new BadRequestException(
        'Cartão não entra em transferência: para pagar a fatura, use o pagamento na tela do cartão.',
      );
    }
    if (!account.isActive) throw new BadRequestException('Conta desativada não movimenta dinheiro');
    return account;
  }

  /** Categoria de despesa do usuário (ou padrão); sem informar, "Juros e tarifas". */
  private async feeCategory(userId: string, categoryId?: string) {
    if (categoryId) {
      const category = await this.prisma.category.findUnique({ where: { id: categoryId } });
      if (
        !category ||
        (category.userId !== null && category.userId !== userId) ||
        category.type !== 'expense'
      ) {
        throw new BadRequestException('Categoria de juros/tarifa inválida');
      }
      return category.id;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { profileType: true },
    });
    const fallback = await this.prisma.category.findFirst({
      where: {
        nature: 'financial_cost',
        type: 'expense',
        profileType: user?.profileType,
        OR: [{ userId }, { userId: null, isDefault: true }],
      },
      orderBy: { isDefault: 'asc' },
    });
    return fallback?.id ?? null;
  }

  private async findByKey(idempotencyKey: string, userId: string) {
    const existing = await this.prisma.accountTransfer.findUnique({
      where: { idempotencyKey },
      include: transferInclude,
    });
    if (!existing) return null;
    if (existing.userId !== userId) {
      this.logger.error('Chave de idempotência de transferência reaproveitada por outro usuário');
      throw new ConflictException('Chave de idempotência já utilizada');
    }
    return transferView(existing, true);
  }
}
