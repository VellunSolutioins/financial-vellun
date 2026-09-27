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
