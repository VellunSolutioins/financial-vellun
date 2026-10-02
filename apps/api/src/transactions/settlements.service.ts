import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SettlementKind, SettlementOrigin } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { isFutureDay, parseDateOnly } from '../common/date.util';
import { Db, FINANCIAL_TX_OPTIONS, cents, lockAccounts, lockTransaction } from '../common/db';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import { SETTLEABLE_TYPES } from './settlement-state';

/** Tamanho da página da conciliação (CLAUDE.md: 10 por página). */
const REVIEW_PAGE_SIZE = 10;

const settlementInclude = {
  account: { select: { id: true, name: true } },
} satisfies Prisma.TransactionSettlementInclude;

type SettlementRow = Prisma.TransactionSettlementGetPayload<{ include: typeof settlementInclude }>;

export function settlementView(s: SettlementRow, idempotent = false) {
  return {
    id: s.id,
    transactionId: s.transactionId,
    amount: Number(s.amount),
    date: s.settledOn.toISOString().slice(0, 10),
    kind: s.kind,
    status: s.status,
    origin: s.origin,
    needsReview: s.needsReview,
    reversedAt: s.reversedAt,
    account: s.account,
    ...(idempotent && { idempotent: true }),
  };
}

/**
 * Grava uma liquidação e atualiza o cache `settledAmount` do lançamento, na
 * transação `tx` de quem chama. Liquidar uma previsão a torna realizada
 * (`forecast = false`). Quem chama já travou o lançamento e as contas e
 * recalcula o saldo depois — `TransactionsService.create` usa isto para o
 * lançamento à vista, que nasce já pago.
 */
export async function recordSettlement(
  tx: Db,
  input: {
    userId: string;
    transactionId: string;
    accountId: string | null;
    amountCents: number;
    date: Date;
    kind?: SettlementKind;
    origin: SettlementOrigin;
    idempotencyKey?: string | null;
  },
) {
  const created = await tx.transactionSettlement.create({
    data: {
      userId: input.userId,
      transactionId: input.transactionId,
      accountId: input.kind === 'write_off' ? null : input.accountId,
      amount: input.amountCents / 100,
      settledOn: input.date,
      kind: input.kind ?? 'payment',
      origin: input.origin,
      idempotencyKey: input.idempotencyKey ?? null,
    },
    include: settlementInclude,
  });
  await tx.transaction.update({
    where: { id: input.transactionId },
    data: { settledAmount: { increment: input.amountCents / 100 }, forecast: false },
  });
  return created;
}

/**
 * Pagamentos, recebimentos e dispensas de lançamentos de conta comum
 * (docs/adrs/0018). O saldo da conta só muda por aqui (e por transferência):
 * vencer não paga nada.
 *
 * Concorrência: cada operação trava o lançamento (`FOR UPDATE`) antes de ler
 * o restante, e as contas tocadas antes de recalcular o saldo. Duas
 * liquidações simultâneas do mesmo lançamento são serializadas, e o `CHECK`
 * do banco (`settled_amount <= amount`) recusa o excedente mesmo que algo
 * escape da trava. A chave de idempotência (única) faz o duplo clique e o
 * retry devolverem a mesma liquidação.
 */
@Injectable()
export class SettlementsService {
  private readonly logger = new Logger(SettlementsService.name);

  constructor(
    private prisma: PrismaService,
    private accountsService: AccountsService,
  ) {}

  async list(userId: string, transactionId: string) {
    await this.findTransaction(userId, transactionId);
    const rows = await this.prisma.transactionSettlement.findMany({
      where: { transactionId, userId },
      include: settlementInclude,
      orderBy: [{ settledOn: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => settlementView(r));
  }

  async settle(userId: string, transactionId: string, dto: CreateSettlementDto) {
    const existing = await this.findByKey(dto.idempotencyKey, userId);
    if (existing) return existing;

    const date = parseDateOnly(dto.date.slice(0, 10));
    if (isFutureDay(date)) {
      throw new BadRequestException(
        'A data do pagamento não pode ser futura: registre quando o dinheiro de fato saiu ou entrou.',
      );
    }
    const kind = dto.kind ?? 'payment';

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await lockTransaction(tx, transactionId);
        const transaction = await this.findTransaction(userId, transactionId, tx);
        assertSettleable(transaction);

        const remainingCents = cents(transaction.amount) - cents(transaction.settledAmount);
        if (remainingCents <= 0) {
          throw new ConflictException('Este lançamento já está liquidado.');
        }
        const amountCents = dto.amount !== undefined ? cents(dto.amount) : remainingCents;
        if (amountCents > remainingCents) {
          throw new BadRequestException(
            `O valor passa do que falta liquidar (R$ ${(remainingCents / 100).toFixed(2)}).`,
          );
        }

        const accountId =
          kind === 'write_off'
            ? null
            : await this.resolveAccount(userId, dto.accountId ?? transaction.accountId, tx);
        await lockAccounts(tx, [accountId]);
        const settlement = await recordSettlement(tx, {
          userId,
          transactionId,
          accountId,
          amountCents,
          date,
          kind,
          origin: 'user',
          idempotencyKey: dto.idempotencyKey,
        });
        if (accountId) await this.accountsService.recalculateBalance(accountId, tx);
        return settlement;
      }, FINANCIAL_TX_OPTIONS);
      return settlementView(created);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.findByKey(dto.idempotencyKey, userId);
        if (raced) return raced;
      }
      throw err;
    }
  }

  /**
   * Reverter marca a liquidação `reversed` (o histórico fica), devolve o
   * valor ao restante do lançamento e recompõe o saldo da conta. Idempotente:
   * reverter de novo devolve a mesma liquidação.
   */
  async reverse(userId: string, transactionId: string, settlementId: string) {
    const reversed = await this.prisma.$transaction(
      (tx) => this.reverseIn(tx, userId, settlementId, transactionId),
      FINANCIAL_TX_OPTIONS,
    );
    return settlementView(reversed);
  }

  /** Liquidações inferidas na migração que o usuário ainda não revisou. */
  async listForReview(userId: string, page = 1) {
    const where = { userId, needsReview: true, status: 'active' as const };
    const [rows, total, sum] = await Promise.all([
      this.prisma.transactionSettlement.findMany({
        where,
        include: {
          ...settlementInclude,
          transaction: {
            select: {
              id: true,
              type: true,
              description: true,
              amount: true,
              transactionDate: true,
              createdAt: true,
              category: { select: { id: true, name: true, color: true } },
            },
          },
        },
        orderBy: [{ settledOn: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * REVIEW_PAGE_SIZE,
        take: REVIEW_PAGE_SIZE,
      }),
      this.prisma.transactionSettlement.count({ where }),
      this.prisma.transactionSettlement.aggregate({ where, _sum: { amount: true } }),
    ]);
    return {
      data: rows.map((r) => ({
        ...settlementView(r),
        transaction: {
          ...r.transaction,
          amount: Number(r.transaction.amount),
          transactionDate: r.transaction.transactionDate.toISOString().slice(0, 10),
        },
      })),
      meta: {
        total,
        totalAmount: Number(sum._sum.amount ?? 0),
        page,
        limit: REVIEW_PAGE_SIZE,
        totalPages: Math.ceil(total / REVIEW_PAGE_SIZE),
      },
    };
  }

  /** Confirma que o pagamento inferido aconteceu: só tira a marca de revisão. */
  async confirmReview(userId: string, settlementId: string) {
    const settlement = await this.findForReview(userId, settlementId);
    const updated = await this.prisma.transactionSettlement.update({
      where: { id: settlement.id },
      data: { needsReview: false, reviewedAt: new Date() },
      include: settlementInclude,
    });
    return settlementView(updated);
  }

  /** Confirma de uma vez todas as inferências pendentes do usuário. */
  async confirmAllReviews(userId: string) {
    const { count } = await this.prisma.transactionSettlement.updateMany({
      where: { userId, needsReview: true, status: 'active' },
      data: { needsReview: false, reviewedAt: new Date() },
    });
    return { confirmed: count };
  }

  /**
   * O pagamento inferido não aconteceu: reverte a liquidação. O lançamento
   * volta a ficar em aberto (vencido, se a data passou) e o saldo da conta é
   * recomposto sem ele.
   */
  async undoReview(userId: string, settlementId: string) {
    const settlement = await this.findForReview(userId, settlementId);
    const reversed = await this.prisma.$transaction(async (tx) => {
      const row = await this.reverseIn(tx, userId, settlement.id);
      return tx.transactionSettlement.update({
        where: { id: row.id },
        data: { needsReview: false, reviewedAt: new Date() },
        include: settlementInclude,
      });
    }, FINANCIAL_TX_OPTIONS);
    return settlementView(reversed);
  }

  private async reverseIn(tx: Db, userId: string, settlementId: string, transactionId?: string) {
    const found = await tx.transactionSettlement.findFirst({
      where: { id: settlementId, userId, ...(transactionId && { transactionId }) },
      select: { transactionId: true },
    });
    if (!found) throw new NotFoundException('Pagamento não encontrado');
    await lockTransaction(tx, found.transactionId);
    // Relida depois da trava: uma reversão concorrente já pode ter passado.
    const settlement = await tx.transactionSettlement.findUniqueOrThrow({
      where: { id: settlementId },
      include: settlementInclude,
    });
    if (settlement.status === 'reversed') return settlement;

    await lockAccounts(tx, [settlement.accountId]);
    const reversed = await tx.transactionSettlement.update({
      where: { id: settlement.id },
      data: { status: 'reversed', reversedAt: new Date() },
      include: settlementInclude,
    });
    await tx.transaction.update({
      where: { id: settlement.transactionId },
      data: { settledAmount: { decrement: settlement.amount } },
    });
    if (settlement.accountId) {
      await this.accountsService.recalculateBalance(settlement.accountId, tx);
    }
    return reversed;
  }

  private async findForReview(userId: string, settlementId: string) {
    const settlement = await this.prisma.transactionSettlement.findFirst({
      where: { id: settlementId, userId, needsReview: true },
    });
    if (!settlement) throw new NotFoundException('Pagamento a revisar não encontrado');
    return settlement;
  }

  private async findTransaction(userId: string, id: string, db: Db = this.prisma) {
    const transaction = await db.transaction.findUnique({
      where: { id },
      include: { account: { select: { type: true } } },
    });
    // 404 também para o lançamento de outro usuário: não confirma que ele existe.
    if (!transaction || transaction.userId !== userId) {
      throw new NotFoundException('Lançamento não encontrado');
    }
    return transaction;
  }

  /** Conta comum ativa do usuário, de onde sai ou para onde entra o dinheiro. */
  private async resolveAccount(userId: string, accountId: string, db: Db) {
    const account = await db.account.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== userId) {
      throw new BadRequestException('Conta inválida');
    }
    if (account.type === 'credit_card') {
      throw new BadRequestException(
        'Cartão não paga lançamento: use uma conta comum. A compra no cartão é paga pela fatura.',
      );
    }
    if (!account.isActive) throw new BadRequestException('Conta desativada não movimenta dinheiro');
    return account.id;
  }

  private async findByKey(idempotencyKey: string, userId: string) {
    const existing = await this.prisma.transactionSettlement.findUnique({
      where: { idempotencyKey },
      include: settlementInclude,
    });
    if (!existing) return null;
    if (existing.userId !== userId) {
      // Mesma postura de CardPaymentsService.findByKey: colisão entre usuários
      // só acontece por bug, e não devolve nada do outro.
      this.logger.error('Chave de idempotência de liquidação reaproveitada por outro usuário');
      throw new ConflictException('Chave de idempotência já utilizada');
    }
    return settlementView(existing, true);
  }
}

function assertSettleable(transaction: {
  status: string;
  type: string;
  account: { type: string };
}) {
  if (transaction.status !== 'confirmed') {
    throw new ConflictException('Lançamento cancelado não pode ser pago');
  }
  if (!(SETTLEABLE_TYPES as readonly string[]).includes(transaction.type)) {
    throw new ConflictException(
      'Transferência, pagamento de fatura e posição inicial já são movimentações: não têm o que liquidar.',
    );
  }
  if (transaction.account.type === 'credit_card') {
    throw new ConflictException(
      'Compra no cartão é paga pela fatura: registre o pagamento na tela do cartão.',
    );
  }
}
