import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { CardLedgerService } from '../credit-cards/card-ledger.service';
import { healthFromPercentage } from '../credit-cards/card-health';
import { dateOnlyString, startOfDayUtc, todaySaoPaulo } from '../common/date.util';
import { TransactionsService } from './transactions.service';
import { UpdateInstallmentDto } from './dto/update-installment.dto';

/**
 * Compra parcelada não é uma entidade própria: é a série de lançamentos
 * `parcelado` com o mesmo `seriesId` (ver `buildSeries`). A tela de
 * Lançamentos mostra as parcelas; a de Parcelamentos, uma linha por compra.
 *
 * Exclusão respeita as mesmas travas da parcela avulsa (docs/adrs/0015):
 * parcela em fatura fechada ou paga, ou com estorno, não sai — a compra se
 * desfaz por estorno.
 */

const parcelInclude = {
  category: { select: { id: true, name: true, color: true } },
  account: { select: { id: true, name: true, type: true } },
} satisfies Prisma.TransactionInclude;

export type Parcel = Prisma.TransactionGetPayload<{ include: typeof parcelInclude }>;

export type DeleteScope = 'all' | 'future';

/** Por que uma parcela não pode ser excluída (trava de fatura ou estorno). */
export type BlockReasons = Map<string, string>;

const REFUND_BLOCK =
  'Esta compra tem estornos. Para desfazê-la, estorne o valor restante em vez de excluir.';

/**
 * Agrupa as parcelas (ordenadas por data) em compras. `today` é o início do
 * dia de hoje: parcelas a partir dele são "de hoje em diante", o mesmo corte
 * das recorrências.
 */
export function groupInstallments(parcels: Parcel[], today: Date, blocked: BlockReasons) {
  const bySeries = new Map<string, Parcel[]>();
  for (const parcel of parcels) {
    if (!parcel.seriesId) continue;
    const list = bySeries.get(parcel.seriesId) ?? [];
    list.push(parcel);
    bySeries.set(parcel.seriesId, list);
  }

  return [...bySeries.entries()].map(([seriesId, list]) => {
    const first = list[0];
    const confirmed = list.filter((p) => p.status === 'confirmed');
    const future = list.filter((p) => p.transactionDate >= today);
    const next = confirmed.find((p) => p.transactionDate >= today);
    const installmentTotal = first.installmentTotal ?? list.length;
    const allBlock = list.map((p) => blocked.get(p.id)).find(Boolean) ?? null;
    const futureBlock = future.map((p) => blocked.get(p.id)).find(Boolean) ?? null;

    // Cancelada: todas as parcelas canceladas (ex.: estorno da compra inteira).
    const status: 'active' | 'finished' | 'cancelled' =
      confirmed.length === 0 ? 'cancelled' : next ? 'active' : 'finished';

    return {
      seriesId,
      description: first.description,
      type: first.type,
      totalAmount: list.reduce((sum, p) => sum + Math.round(Number(p.amount) * 100), 0) / 100,
      installmentAmount: Number(first.amount),
      installmentTotal,
      /** Parcelas que ainda existem (menos que o total se as futuras foram excluídas). */
      parcelCount: list.length,
      /** Parcelas com data anterior a hoje. */
      pastCount: list.length - future.length,
      /** Parcelas de hoje em diante, em qualquer status. */
      futureCount: future.length,
      status,
      firstDate: first.transactionDate,
      lastDate: list[list.length - 1].transactionDate,
      nextDate: next?.transactionDate ?? null,
      nextNumber: next?.installmentNumber ?? null,
      accountId: first.accountId,
      categoryId: first.categoryId,
      account: first.account,
      category: first.category,
      canDeleteAll: !allBlock,
      deleteAllBlockedReason: allBlock,
      canDeleteFuture: future.length > 0 && !futureBlock,
      deleteFutureBlockedReason:
        future.length === 0 ? 'Não há parcelas de hoje em diante.' : futureBlock,
      /** Parcela usada para o estorno da compra inteira; null se não há o que estornar. */
      refundAnchorId: first.type === 'expense' ? (confirmed[0]?.id ?? null) : null,
    };
  });
}

export type Installment = ReturnType<typeof groupInstallments>[number];

/** Em andamento primeiro (próxima parcela mais cedo), depois as encerradas (mais recentes). */
export function sortInstallments(list: Installment[]) {
  const rank = { active: 0, finished: 1, cancelled: 2 } as const;
  return [...list].sort((a, b) => {
    if (a.status !== b.status) return rank[a.status] - rank[b.status];
    if (a.status === 'active') return a.nextDate!.getTime() - b.nextDate!.getTime();
    return b.lastDate.getTime() - a.lastDate.getTime();
  });
}

export interface SummaryInput {
  /** Cartões ativos. */
  cards: { accountId: string; name: string; color: string | null; creditLimit: number | null }[];
  /** Parcelas de cartão ainda não faturadas (fatura aberta ou futura). */
  unbilled: { accountId: string; amount: number }[];
  /** Parcelas a pagar: de cartão ainda não faturadas; de conta, de hoje em diante. */
  remaining: {
    categoryId: string | null;
    categoryName: string | null;
    color: string | null;
    amount: number;
  }[];
}

const cents = (v: number) => Math.round(v * 100);

/**
 * Por cartão, quanto do limite está comprometido com parcelas ainda não
 * faturadas (só os cartões com alguma); e o restante a pagar dos
 * parcelamentos, por categoria. Cartão sem limite cadastrado não tem
 * percentual nem faixa.
 */
export function buildInstallmentsSummary(input: SummaryInput) {
  const byAccount = new Map<string, number>();
  for (const p of input.unbilled) {
    byAccount.set(p.accountId, (byAccount.get(p.accountId) ?? 0) + cents(p.amount));
  }

  const byCard = input.cards
    .map((c) => {
      const committed = (byAccount.get(c.accountId) ?? 0) / 100;
      const percentage = c.creditLimit ? (committed / c.creditLimit) * 100 : null;
      return {
        ...c,
        committed,
        percentage,
        health: percentage !== null ? healthFromPercentage(percentage) : null,
      };
    })
    .filter((c) => c.committed > 0)
    .sort((a, b) => b.committed - a.committed);

  const categories = new Map<
    string,
    { categoryId: string | null; categoryName: string; color: string | null; cents: number }
  >();
  for (const p of input.remaining) {
    const key = p.categoryId ?? 'uncategorized';
    const entry = categories.get(key) ?? {
      categoryId: p.categoryId,
      categoryName: p.categoryName ?? 'Sem categoria',
      color: p.color,
      cents: 0,
    };
    entry.cents += cents(p.amount);
    categories.set(key, entry);
  }
  const remainingCents = [...categories.values()].reduce((sum, c) => sum + c.cents, 0);
  const byCategory = [...categories.values()]
    .map(({ cents: total, ...c }) => ({
      ...c,
      total: total / 100,
      percentage: remainingCents > 0 ? (total / remainingCents) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  return { byCard, remaining: remainingCents / 100, byCategory };
}

@Injectable()
export class InstallmentsService {
  constructor(
    private prisma: PrismaService,
    private accountsService: AccountsService,
    private transactionsService: TransactionsService,
    private cardLedger: CardLedgerService = new CardLedgerService(prisma),
  ) {}

  private today() {
    return startOfDayUtc(dateOnlyString(todaySaoPaulo()));
  }

  async findAll(userId: string) {
    const parcels = await this.prisma.transaction.findMany({
      where: { userId, recurrenceType: 'parcelado', seriesId: { not: null } },
      include: parcelInclude,
      orderBy: [{ transactionDate: 'asc' }, { installmentNumber: 'asc' }],
    });
    const blocked = await this.blockReasons(parcels);
    return sortInstallments(groupInstallments(parcels, this.today(), blocked));
  }

  /**
   * Limite comprometido por cartão e restante a pagar por categoria. No
   * cartão, "a pagar" é o que ainda não foi faturado — inclusive parcela com
   * data passada que está na fatura aberta; em conta, as de hoje em diante.
   * Assim a rosca e as barras dos cartões contam as mesmas parcelas.
   */
  async summary(userId: string) {
    const today = this.today();
    const confirmedParcels = {
      userId,
      recurrenceType: 'parcelado' as const,
      seriesId: { not: null },
      status: 'confirmed' as const,
      type: 'expense' as const,
    };
    const category = { select: { id: true, name: true, color: true } };

    const [cards, cardParcels, accountParcels] = await Promise.all([
      this.prisma.creditCard.findMany({
        where: { account: { userId, isActive: true } },
        select: {
          accountId: true,
          color: true,
          creditLimit: true,
          account: { select: { name: true } },
        },
      }),
      this.prisma.transaction.findMany({
        where: { ...confirmedParcels, account: { type: 'credit_card' } },
        select: {
          id: true,
          accountId: true,
          amount: true,
          transactionDate: true,
          invoiceId: true,
          cardPaymentId: true,
          category,
        },
      }),
      this.prisma.transaction.findMany({
        where: {
          ...confirmedParcels,
          account: { type: { not: 'credit_card' } },
          transactionDate: { gte: today },
        },
        select: { amount: true, category },
      }),
    ]);
    // Fatura fechada ou paga = já faturada: vira dívida da fatura. Sem fatura
    // (cartão ainda não configurado, ou compra anterior ao controle), vale a data.
    const billed = await this.cardLedger.lockReasons(cardParcels);
    const unbilled = cardParcels.filter((p) =>
      p.invoiceId ? !billed.has(p.id) : p.transactionDate >= today,
    );

    const toRemaining = (p: {
      amount: Prisma.Decimal;
      category: { id: string; name: string; color: string | null } | null;
    }) => ({
      categoryId: p.category?.id ?? null,
      categoryName: p.category?.name ?? null,
      color: p.category?.color ?? null,
      amount: Number(p.amount),
    });

    return buildInstallmentsSummary({
      cards: cards.map((c) => ({
        accountId: c.accountId,
        name: c.account.name,
        color: c.color,
        creditLimit: c.creditLimit !== null ? Number(c.creditLimit) : null,
      })),
      unbilled: unbilled.map((p) => ({ accountId: p.accountId, amount: Number(p.amount) })),
      remaining: [...unbilled, ...accountParcels].map(toRemaining),
    });
  }

  async findOne(userId: string, seriesId: string) {
    const parcels = await this.findSeries(userId, seriesId);
    const [installment] = groupInstallments(
      parcels,
      this.today(),
      await this.blockReasons(parcels),
    );
    return installment;
  }

  /** Descrição e categoria valem para todas as parcelas, inclusive as faturadas. */
  async update(userId: string, seriesId: string, dto: UpdateInstallmentDto) {
    const parcels = await this.findSeries(userId, seriesId);
    if (dto.categoryId) {
      await this.transactionsService.validateOwnership(
        userId,
        undefined,
        dto.categoryId,
        parcels[0].type,
      );
    }
    await this.prisma.transaction.updateMany({
      where: { id: { in: parcels.map((p) => p.id) } },
      data: {
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.categoryId !== undefined && { categoryId: dto.categoryId || null }),
      },
    });
    return this.findOne(userId, seriesId);
  }

  /**
   * `all` apaga a compra inteira; `future`, as parcelas de hoje em diante
   * (as anteriores ficam como estão). Qualquer parcela atingida que esteja
   * travada bloqueia a operação inteira — nada é apagado pela metade.
   */
  async remove(userId: string, seriesId: string, scope: DeleteScope) {
    const parcels = await this.findSeries(userId, seriesId);
    const today = this.today();
    const targets = scope === 'all' ? parcels : parcels.filter((p) => p.transactionDate >= today);
    if (targets.length === 0) {
      throw new BadRequestException('Não há parcelas de hoje em diante para excluir.');
    }

    const [reason] = (await this.blockReasons(targets)).values();
    if (reason) {
      throw new ConflictException(
        scope === 'all'
          ? `${reason} Exclua só as parcelas de hoje em diante ou estorne a compra.`
          : reason,
      );
    }

    const { count } = await this.prisma.transaction.deleteMany({
      where: { id: { in: targets.map((p) => p.id) } },
    });

    for (const accountId of new Set(targets.map((p) => p.accountId))) {
      await this.accountsService.recalculateBalance(accountId);
      await this.cardLedger.pruneForAccount(accountId);
    }
    return { deleted: count };
  }

  private async findSeries(userId: string, seriesId: string) {
    const parcels = await this.prisma.transaction.findMany({
      where: { userId, seriesId, recurrenceType: 'parcelado' },
      include: parcelInclude,
      orderBy: [{ transactionDate: 'asc' }, { installmentNumber: 'asc' }],
    });
    if (parcels.length === 0) throw new NotFoundException('Parcelamento não encontrado');
    return parcels;
  }

  /** Trava de fatura (fechada/paga) e estornos, por parcela. */
  private async blockReasons(parcels: Parcel[]): Promise<BlockReasons> {
    const reasons: BlockReasons = await this.cardLedger.lockReasons(parcels);
    if (parcels.length === 0) return reasons;
    const refunded = await this.prisma.transaction.groupBy({
      by: ['refundOfId'],
      where: { refundOfId: { in: parcels.map((p) => p.id) }, status: 'confirmed' },
    });
    for (const { refundOfId } of refunded) {
      if (refundOfId && !reasons.has(refundOfId)) reasons.set(refundOfId, REFUND_BLOCK);
    }
    return reasons;
  }
}
