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
import { reconcileCard } from '../credit-cards/card-reconciliation';
import { healthFromPercentage } from '../credit-cards/card-health';
import {
  dateOnlyString,
  endOfDayUtc,
  parseDateOnly,
  startOfDayUtc,
  todaySaoPaulo,
} from '../common/date.util';
import { FINANCIAL_TX_OPTIONS, cents as toCents, lockAccounts } from '../common/db';
import { recordSettlement } from './settlements.service';
import { TransactionsService } from './transactions.service';
import { AdvanceInstallmentDto, UpdateInstallmentDto } from './dto/update-installment.dto';
import { advanceState, distributeAdvance } from './installment-advance';

/**
 * Compra parcelada: a operação original (`installment_purchases`, `id =
 * seriesId`) com data e total próprios, e as parcelas — lançamentos
 * `parcelado` com o mesmo `seriesId` — como calendário de cobrança
 * (docs/adrs/0018). A tela de Lançamentos mostra as parcelas; a de
 * Parcelamentos, uma linha por compra.
 *
 * Exclusão respeita as mesmas travas da parcela avulsa (docs/adrs/0015):
 * parcela em fatura fechada ou paga, com estorno ou com pagamento registrado
 * não sai — a compra se desfaz por estorno.
 */

const parcelInclude = {
  category: { select: { id: true, name: true, color: true } },
  account: { select: { id: true, name: true, type: true } },
  // Fatura futura ou aberta: decide o que pode ser adiantado.
  invoice: { select: { periodStart: true } },
  purchase: { select: { purchaseDate: true, totalAmount: true } },
} satisfies Prisma.TransactionInclude;

export type Parcel = Prisma.TransactionGetPayload<{ include: typeof parcelInclude }>;

export type DeleteScope = 'all' | 'future';

/** Por que uma parcela não pode ser excluída (trava de fatura ou estorno). */
export type BlockReasons = Map<string, string>;

const REFUND_BLOCK =
  'Esta compra tem estornos. Para desfazê-la, estorne o valor restante em vez de excluir.';

const SETTLED_BLOCK =
  'Esta parcela já tem pagamento registrado. Reverta o pagamento antes, ou estorne a compra.';

/**
 * Quanto falta pagar de cada parcela, em centavos (docs/adrs/0018):
 * - conta comum: valor − liquidado;
 * - cartão, em fatura: a parte da parcela no restante conciliado da fatura,
 *   pro rata (a fatura paga pela metade deixa metade de cada cobrança);
 * - cartão sem fatura: pendente de configuração (vale a data) ou anterior ao
 *   controle (coberta pela posição inicial — fica de fora).
 * Compra com data futura é previsão: não entra no compromisso.
 */
export type RemainingByParcel = ReadonlyMap<string, number>;

/**
 * Agrupa as parcelas (ordenadas por data) em compras. `today` é o início do
 * dia de hoje: parcelas a partir dele são "de hoje em diante", o mesmo corte
 * das recorrências.
 */
export function groupInstallments(
  parcels: Parcel[],
  today: Date,
  blocked: BlockReasons,
  remainingByParcel: RemainingByParcel = new Map(),
) {
  const bySeries = new Map<string, Parcel[]>();
  for (const parcel of parcels) {
    if (!parcel.seriesId) continue;
    const list = bySeries.get(parcel.seriesId) ?? [];
    list.push(parcel);
    bySeries.set(parcel.seriesId, list);
  }

  return [...bySeries.entries()].map(([seriesId, list]) => {
    // A parcela 1, não a de data mais antiga: uma parcela adiantada para hoje
    // pode vir antes dela na ordem por data.
    const first = list.reduce((a, b) =>
      (b.installmentNumber ?? Infinity) < (a.installmentNumber ?? Infinity) ? b : a,
    );
    const confirmed = list.filter((p) => p.status === 'confirmed');
    const future = list.filter((p) => p.transactionDate >= today);
    // Adiantadas ficam com a data de hoje, mas não são a "próxima" parcela.
    const next =
      confirmed.find((p) => p.transactionDate >= today && !p.advancedAt) ??
      confirmed.find((p) => p.transactionDate >= today);
    const installmentTotal = first.installmentTotal ?? list.length;
    const allBlock = list.map((p) => blocked.get(p.id)).find(Boolean) ?? null;
    const futureBlock = future.map((p) => blocked.get(p.id)).find(Boolean) ?? null;
    const advance = advanceState(list, today, blocked);

    // Cancelada: todas as parcelas canceladas (ex.: estorno da compra inteira).
    const status: 'active' | 'finished' | 'cancelled' =
      confirmed.length === 0 ? 'cancelled' : next ? 'active' : 'finished';
    const purchaseDate = first.purchase?.purchaseDate ?? first.eventDate;

    return {
      seriesId,
      description: first.description,
      type: first.type,
      /** Data da compra: é nela que o gasto é reconhecido, não em cada parcela. */
      purchaseDate,
      /** Compra com data futura: previsão, ainda não é compromisso. */
      isForecast: purchaseDate > today && !sameUtcDay(purchaseDate, today),
      /** Valor contratado (antes de descontos de adiantamento e cancelamentos). */
      contractAmount: Number(first.purchase?.totalAmount ?? 0) || null,
      totalAmount: list.reduce((sum, p) => sum + Math.round(Number(p.amount) * 100), 0) / 100,
      /** O que ainda falta pagar da compra (parcelas não pagas, já sem o pago). */
      remainingCommitment:
        confirmed.reduce((sum, p) => sum + (remainingByParcel.get(p.id) ?? 0), 0) / 100,
      installmentAmount: Number(first.amountBeforeAdvance ?? first.amount),
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
      /**
       * Parcela do mês atual (no cartão, a da fatura aberta), 0 se a compra
       * ainda não começou; e a primeira de um mês seguinte. Mesmo critério do
       * adiantamento e da tela de Lançamentos.
       */
      currentNumber: advance.currentNumber,
      upcomingNumber: advance.upcomingNumber,
      upcomingDate: advance.upcomingDate,
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
      refundAnchorId:
        first.type === 'expense'
          ? ((confirmed.find((p) => p.id === first.id) ?? confirmed[0])?.id ?? null)
          : null,
      /** Parcelas que podem ser adiantadas, da última para a primeira. */
      advanceable: advance.advanceable.map((p) => ({
        id: p.id,
        installmentNumber: p.installmentNumber,
        amount: Number(p.amount),
        transactionDate: p.transactionDate,
      })),
      advanceBlockedReason: advance.blockedReason,
      /** Parcelas já adiantadas (confirmadas). */
      advancedCount: confirmed.filter((p) => p.advancedAt).length,
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

function sameUtcDay(a: Date, b: Date) {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

export interface SummaryInput {
  /** Cartões (os arquivados também: a compra continua sendo devida). */
  cards: {
    accountId: string;
    name: string;
    color: string | null;
    creditLimit: number | null;
    isActive?: boolean;
  }[];
  /** O que falta pagar das parcelas de cada cartão (ver `RemainingByParcel`). */
  cardRemaining: { accountId: string; amount: number }[];
  /** Compromisso restante por parcela (ver `RemainingByParcel`). */
  remaining: {
    categoryId: string | null;
    categoryName: string | null;
    color: string | null;
    amount: number;
  }[];
}

const cents = (v: number) => Math.round(v * 100);

/**
 * Por cartão, quanto falta pagar das compras parceladas e quanto isso ocupa do
 * limite (só os cartões com algum valor; docs/adrs/0020); e o restante a pagar
 * dos parcelamentos, por categoria. Cartão sem limite cadastrado não tem
 * percentual nem faixa.
 */
export function buildInstallmentsSummary(input: SummaryInput) {
  const byAccount = new Map<string, number>();
  for (const p of input.cardRemaining) {
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
    const [blocked, remaining] = await Promise.all([
      this.blockReasons(parcels),
      this.remainingFor(parcels),
    ]);
    return sortInstallments(groupInstallments(parcels, this.today(), blocked, remaining));
  }

  /** Compromisso restante das parcelas de compras já feitas (as futuras são previsão). */
  private async remainingFor(parcels: Parcel[]) {
    const endOfToday = endOfDayUtc(dateOnlyString(todaySaoPaulo()));
    const effective = parcels.filter((p) => p.eventDate <= endOfToday);
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: [...new Set(effective.map((p) => p.accountId))] } },
      select: { id: true, type: true, creditCard: { select: { invoiceTrackingStart: true } } },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return this.remainingByParcel(
      effective.map((p) => ({ ...p, account: byId.get(p.accountId) ?? p.account })),
    );
  }

  /**
   * Por cartão e por categoria, o que falta pagar das compras parceladas já
   * feitas (`RemainingByParcel`: desconta o que a fatura já pagou, inclusive
   * fatura fechada e ainda não paga). Cartões arquivados entram: arquivar não
   * apaga o que se deve.
   */
  async summary(userId: string) {
    const category = { select: { id: true, name: true, color: true } };

    const [cards, parcels] = await Promise.all([
      this.prisma.creditCard.findMany({
        where: { account: { userId } },
        select: {
          accountId: true,
          color: true,
          creditLimit: true,
          account: { select: { name: true, isActive: true } },
        },
      }),
      this.prisma.transaction.findMany({
        where: {
          userId,
          recurrenceType: 'parcelado',
          seriesId: { not: null },
          status: 'confirmed',
          type: 'expense',
          eventDate: { lte: endOfDayUtc(dateOnlyString(todaySaoPaulo())) },
        },
        select: {
          id: true,
          accountId: true,
          amount: true,
          settledAmount: true,
          transactionDate: true,
          invoiceId: true,
          cardPaymentId: true,
          account: {
            select: { type: true, creditCard: { select: { invoiceTrackingStart: true } } },
          },
          category,
        },
      }),
    ]);
    const remaining = await this.remainingByParcel(parcels);

    return buildInstallmentsSummary({
      cards: cards.map((c) => ({
        accountId: c.accountId,
        name: c.account.name,
        color: c.color,
        creditLimit: c.creditLimit !== null ? Number(c.creditLimit) : null,
        isActive: c.account.isActive,
      })),
      cardRemaining: parcels
        .filter((p) => p.account.type === 'credit_card')
        .map((p) => ({ accountId: p.accountId, amount: (remaining.get(p.id) ?? 0) / 100 })),
      remaining: parcels
        .filter((p) => (remaining.get(p.id) ?? 0) > 0)
        .map((p) => ({
          categoryId: p.category?.id ?? null,
          categoryName: p.category?.name ?? null,
          color: p.category?.color ?? null,
          amount: (remaining.get(p.id) ?? 0) / 100,
        })),
    });
  }

  /** Compromisso restante de cada parcela, em centavos (ver `RemainingByParcel`). */
  private async remainingByParcel(
    parcels: readonly {
      id: string;
      amount: Prisma.Decimal;
      settledAmount: Prisma.Decimal;
      status?: string;
      transactionDate: Date;
      invoiceId: string | null;
      accountId: string;
      account: { type: string; creditCard?: { invoiceTrackingStart: Date | null } | null };
    }[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const today = this.today();
    const invoiceIds = [...new Set(parcels.map((p) => p.invoiceId).filter(Boolean))] as string[];
    const shareByInvoice = new Map<string, number>();
    if (invoiceIds.length) {
      const cardIds = (
        await this.prisma.creditCardInvoice.findMany({
          where: { id: { in: invoiceIds } },
          select: { creditCardId: true },
          distinct: ['creditCardId'],
        })
      ).map((i) => i.creditCardId);
      const amounts = await this.cardLedger.invoicesWithAmounts(cardIds);
      for (const invoices of amounts.values()) {
        for (const row of reconcileCard(invoices).invoices) {
          const total = row.debitCents;
          shareByInvoice.set(row.invoice.span.id, total > 0 ? row.remainingCents / total : 0);
        }
      }
    }
    for (const p of parcels) {
      if (p.status && p.status !== 'confirmed') continue;
      const amount = toCents(p.amount);
      if (p.account.type !== 'credit_card') {
        result.set(p.id, Math.max(0, amount - toCents(p.settledAmount)));
      } else if (p.invoiceId) {
        result.set(p.id, Math.round(amount * (shareByInvoice.get(p.invoiceId) ?? 0)));
      } else {
        // Sem fatura: cartão sem configuração (vale a data) ou parcela anterior
        // ao controle (coberta pela posição inicial).
        const trackingStart = p.account.creditCard?.invoiceTrackingStart ?? null;
        result.set(p.id, trackingStart === null && p.transactionDate >= today ? amount : 0);
      }
    }
    return result;
  }

  async findOne(userId: string, seriesId: string) {
    const parcels = await this.findSeries(userId, seriesId);
    const [installment] = groupInstallments(
      parcels,
      this.today(),
      await this.blockReasons(parcels),
      await this.remainingFor(parcels),
    );
    return {
      ...installment,
      /**
       * Calendário de cobrança: cada parcela com vencimento, fatura e o que
       * falta pagar dela. É uma visão de compromissos, não de gastos — o gasto
       * é a compra, na data dela.
       */
      schedule: parcels
        .slice()
        .sort((a, b) => (a.installmentNumber ?? 0) - (b.installmentNumber ?? 0))
        .map((p) => ({
          id: p.id,
          installmentNumber: p.installmentNumber,
          dueDate: p.transactionDate.toISOString().slice(0, 10),
          amount: Number(p.amount),
          status: p.status,
          invoiceId: p.invoiceId,
          settledAmount: Number(p.settledAmount),
          advancedAt: p.advancedAt,
        })),
    };
  }

  /**
   * Descrição e categoria valem para todas as parcelas, inclusive as
   * faturadas. A data da compra muda a data do fato de todas; no cartão, ela
   * decide as faturas, por isso só muda enquanto nada estiver travado.
   */
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
    const purchaseDate = dto.purchaseDate
      ? parseDateOnly(dto.purchaseDate.slice(0, 10))
      : undefined;
    const isCard = parcels[0].account.type === 'credit_card';
    if (purchaseDate && isCard) {
      const [reason] = (await this.cardLedger.lockReasons(parcels)).values();
      if (reason) throw new ConflictException(reason);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.transaction.updateMany({
        where: { id: { in: parcels.map((p) => p.id) } },
        data: {
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.categoryId !== undefined && { categoryId: dto.categoryId || null }),
          ...(purchaseDate && { eventDate: purchaseDate }),
        },
      });
      await tx.installmentPurchase.updateMany({
        where: { id: seriesId, userId },
        data: {
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.categoryId !== undefined && { categoryId: dto.categoryId || null }),
          ...(purchaseDate && { purchaseDate }),
        },
      });
      if (purchaseDate && isCard) {
        await this.cardLedger.syncTransactions(
          parcels.map((p) => p.id),
          tx,
        );
        await this.accountsService.recalculateBalance(parcels[0].accountId, tx);
      }
    }, FINANCIAL_TX_OPTIONS);
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

    const count = await this.prisma.$transaction(async (tx) => {
      const accountIds = [...new Set(targets.map((p) => p.accountId))];
      await lockAccounts(tx, accountIds);
      const { count: deleted } = await tx.transaction.deleteMany({
        where: { id: { in: targets.map((p) => p.id) }, settledAmount: 0 },
      });
      // Sem parcela nenhuma, a compra não tem mais o que representar.
      await tx.installmentPurchase.deleteMany({
        where: { id: seriesId, userId, installments: { none: {} } },
      });
      for (const accountId of accountIds) {
        await this.accountsService.recalculateBalance(accountId, tx);
        await this.cardLedger.pruneForAccount(accountId, tx);
      }
      return deleted;
    }, FINANCIAL_TX_OPTIONS);
    return { deleted: count };
  }

  /**
   * Adianta as `count` últimas parcelas ainda futuras para hoje: no cartão,
   * caem na fatura aberta (docs/adrs/0017). Com `amount`, o total delas passa
   * a ser esse (desconto do adiantamento), rateado entre as parcelas.
   * `expectedLastNumber` protege contra reenvio: se a cauda mudou desde que o
   * cliente a leu (o mesmo pedido já foi aplicado), nada é adiantado.
   */
  async advance(userId: string, seriesId: string, dto: AdvanceInstallmentDto) {
    const parcels = await this.findSeries(userId, seriesId);
    const today = this.today();
    const blocked = await this.blockReasons(parcels);
    const { advanceable: available, blockedReason } = advanceState(parcels, today, blocked);
    if (
      dto.expectedLastNumber !== undefined &&
      available[0]?.installmentNumber !== dto.expectedLastNumber
    ) {
      throw new ConflictException(
        'O parcelamento mudou desde que você abriu esta tela (talvez já tenha sido adiantado). Recarregue e confira.',
      );
    }
    if (available.length === 0) throw new BadRequestException(blockedReason);
    if (dto.count > available.length) {
      throw new BadRequestException(
        `Só é possível adiantar até ${available.length} parcela${available.length === 1 ? '' : 's'}.`,
      );
    }

    // Da menor para a maior: o rateio deixa a sobra na última parcela.
    const targets = available.slice(0, dto.count).reverse();
    const currentCents = targets.map((p) => cents(Number(p.amount)));
    let newCents = currentCents;
    if (dto.amount !== undefined) {
      const sumCents = currentCents.reduce((acc, c) => acc + c, 0);
      const targetCents = cents(dto.amount);
      if (targetCents > sumCents) {
        throw new BadRequestException(
          `O valor com desconto passa da soma das parcelas (R$ ${(sumCents / 100).toFixed(2)}).`,
        );
      }
      newCents = distributeAdvance(currentCents, targetCents);
      if (newCents.some((c) => c <= 0)) {
        throw new BadRequestException(
          'O valor com desconto é baixo demais: alguma parcela ficaria sem valor.',
        );
      }
    }
    const discounted = dto.amount !== undefined && newCents.some((c, i) => c !== currentCents[i]);
    const isCard = targets[0].account.type === 'credit_card';

    await this.prisma.$transaction(async (tx) => {
      const accountIds = [...new Set(targets.map((p) => p.accountId))];
      await lockAccounts(tx, accountIds);
      for (const [i, p] of targets.entries()) {
        await tx.transaction.update({
          where: { id: p.id },
          data: {
            transactionDate: today,
            advancedAt: today,
            advancedFromDate: p.transactionDate,
            ...(discounted && { amount: newCents[i] / 100, amountBeforeAdvance: p.amount }),
          },
        });
        // Em conta comum, adiantar é pagar agora: o dinheiro sai hoje. No
        // cartão, a parcela vai para a fatura aberta e é paga com ela.
        if (!isCard) {
          await recordSettlement(tx, {
            userId,
            transactionId: p.id,
            accountId: p.accountId,
            amountCents: newCents[i],
            date: today,
            origin: 'user',
          });
        }
      }
      await this.cardLedger.syncTransactions(
        targets.map((p) => p.id),
        tx,
      );
      for (const accountId of accountIds) {
        await this.accountsService.recalculateBalance(accountId, tx);
        await this.cardLedger.pruneForAccount(accountId, tx);
      }
    }, FINANCIAL_TX_OPTIONS);
    return this.findOne(userId, seriesId);
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

  /** Trava de fatura (fechada/paga), pagamento registrado e estornos, por parcela. */
  private async blockReasons(parcels: Parcel[]): Promise<BlockReasons> {
    const reasons: BlockReasons = await this.cardLedger.lockReasons(parcels);
    if (parcels.length === 0) return reasons;
    for (const p of parcels) {
      if (toCents(p.settledAmount) > 0 && !reasons.has(p.id)) reasons.set(p.id, SETTLED_BLOCK);
    }
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
