import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  CalendarDay,
  addDaysSaoPaulo,
  calendarDayFromUtcDate,
  compareCalendarDays,
  dateOnlyString,
  parseDateOnly,
  todaySaoPaulo,
  startOfMonthUtc,
  endOfMonthUtc,
  isFutureDay,
} from '../common/date.util';
import { FINANCIAL_TX_OPTIONS, cents, lockCreditCard } from '../common/db';
import { AccountsService } from '../accounts/accounts.service';

import { healthFromPercentage, incomeHealthFromPercentage } from './card-health';
import { cardNeedsSetup } from './card-setup';
import { clearPreferredAccount } from '../financial-resources/preferred-account';
import {
  CardLedgerService,
  INVOICE_ENTRY_TYPES,
  OPENING_TYPES,
  StoredSpan,
  toDbDate,
} from './card-ledger.service';
import { CreateCreditCardDto } from './dto/create-credit-card.dto';
import { OpeningPositionDto } from './dto/opening-position.dto';
import { SetupCreditCardDto } from './dto/setup-credit-card.dto';
import { UpdateCreditCardDto } from './dto/update-credit-card.dto';
import {
  InvoiceAmounts,
  InvoiceSpan,
  cardPosition,
  closingDateIn,
  configCycleFor,
  cycleState,
  dueDateAfter,
  paymentStatus,
  referenceMonthOf,
} from './invoice-cycle';
import { CreditApplication, ReconciledInvoice } from './card-reconciliation';

type CardWithAccount = Prisma.CreditCardGetPayload<{ include: { account: true } }>;

const fromCents = (cents: number) => cents / 100;

/** Dia-calendário como `YYYY-MM-DD`. */
const dayString = (day: CalendarDay) => dateOnlyString(day);

const applicationView = (a: CreditApplication, side: 'from' | 'to') => ({
  invoiceId: side === 'from' ? a.fromInvoiceId : a.toInvoiceId,
  referenceMonth: side === 'from' ? a.fromReferenceMonth : a.toReferenceMonth,
  amount: fromCents(a.cents),
});

/**
 * Valores de uma fatura, na forma exposta pela API, já conciliados com as
 * demais faturas do cartão: `remaining` é o que de fato falta pagar depois dos
 * créditos vindos de outras faturas (`creditsApplied`, com a origem de cada
 * um). `grossRemaining` é o restante antes deles.
 */
export function invoiceView(
  row: ReconciledInvoice<StoredSpan>,
  today: CalendarDay,
  current: InvoiceSpan,
  trackingStart: CalendarDay | null = null,
) {
  const { invoice } = row;
  const { span } = invoice;
  const totalCents = row.debitCents - invoice.refundsCents - (invoice.openingCreditCents ?? 0);
  const state = cycleState(span, today);
  return {
    id: span.id,
    referenceMonth: span.referenceMonth,
    periodStart: dayString(span.periodStart),
    closingDate: dayString(span.closingDate),
    dueDate: dayString(span.dueDate),
    /** `open` até a véspera do fechamento; depois, `closed`. */
    state,
    isCurrent: span.referenceMonth === current.referenceMonth,
    isFuture: compareCalendarDays(span.closingDate, current.closingDate) > 0,
    /** Fatura anterior ao início do controle: só a posição inicial. */
    isOpening: trackingStart !== null && compareCalendarDays(span.closingDate, trackingStart) <= 0,
    charges: fromCents(invoice.chargesCents),
    refunds: fromCents(invoice.refundsCents),
    payments: fromCents(invoice.paymentsCents),
    openingDebt: fromCents(invoice.openingDebtCents ?? 0),
    openingCredit: fromCents(invoice.openingCreditCents ?? 0),
    /** Cobranças previstas (assinatura ou compra futura): fora do total e da dívida. */
    forecast: fromCents(invoice.forecastCents ?? 0),
    total: fromCents(totalCents),
    grossRemaining: fromCents(row.grossRemainingCents),
    creditsApplied: row.creditsApplied.map((a) => applicationView(a, 'from')),
    remaining: fromCents(row.remainingCents),
    /** Crédito que esta fatura gerou e para onde foi. */
    surplus: fromCents(row.surplusCents),
    surplusAppliedTo: row.surplusAppliedTo.map((a) => applicationView(a, 'to')),
    unappliedSurplus: fromCents(row.unappliedSurplusCents),
    isOverdue:
      state === 'closed' && compareCalendarDays(span.dueDate, today) < 0 && row.remainingCents > 0,
    paymentStatus: paymentStatus(
      totalCents,
      invoice.paymentsCents,
      row.remainingCents,
      row.unappliedSurplusCents,
    ),
  };
}

type OpeningRow = {
  accountId: string;
  type: string;
  amount: Prisma.Decimal;
  invoice: { dueDate: Date } | null;
};

@Injectable()
export class CreditCardsService {
  constructor(
    private prisma: PrismaService,
    private cardLedger: CardLedgerService = new CardLedgerService(prisma),
    private accountsService: AccountsService = new AccountsService(prisma),
  ) {}

  /**
   * Indicadores do cartão. Nada aqui usa `currentBalance`: fatura, dívida e
   * limite saem das faturas conciliadas (`reconcileCard`). Cartão com
   * configuração pendente não tem esses números — `debtKnown: false` diz que
   * a dívida é desconhecida, não zero.
   *
   * O limite disponível é uma **estimativa**: a operadora pode aplicar crédito,
   * processar estorno ou liberar limite em momentos diferentes (ADR 0018).
   */
  private toCardView(
    card: CardWithAccount,
    invoices: InvoiceAmounts<StoredSpan>[] = [],
    preferredAccountId: string | null = null,
    opening: OpeningRow[] = [],
  ) {
    const creditLimit = card.creditLimit ? Number(card.creditLimit) : null;
    const needsSetup = cardNeedsSetup(card);
    const openingDebt = opening.find((o) => o.type === 'opening_debt');
    const openingCredit = opening.find((o) => o.type === 'opening_credit');
    const base = {
      id: card.id,
      accountId: card.account.id,
      name: card.account.name,
      brand: card.brand,
      color: card.color,
      creditLimit,
      closingDay: card.closingDay,
      dueDay: card.dueDay,
      invoiceTrackingStart: card.invoiceTrackingStart
        ? card.invoiceTrackingStart.toISOString().slice(0, 10)
        : null,
      paymentAccountId: card.paymentAccountId,
      needsSetup,
      /** `false`: sem configuração, a dívida do cartão não é conhecida (não é zero). */
      debtKnown: !needsSetup,
      isActive: card.account.isActive,
      /** Pré-selecionado em novos lançamentos (um só entre contas e cartões). */
      isPreferred: card.account.isActive && card.account.id === preferredAccountId,
      /** Dívida e crédito no início do controle (nulo se não informados). */
      openingPosition:
        openingDebt || openingCredit
          ? {
              previousInvoiceAmount: openingDebt ? Number(openingDebt.amount) : 0,
              previousInvoiceDueDate: openingDebt?.invoice
                ? openingDebt.invoice.dueDate.toISOString().slice(0, 10)
                : null,
              credit: openingCredit ? Number(openingCredit.amount) : 0,
            }
          : null,
    };
    if (needsSetup) {
      return {
        ...base,
        currentInvoice: null,
        currentInvoiceRemaining: null,
        currentInvoiceId: null,
        currentClosingDate: null,
        currentDueDate: null,
        futureCharges: null,
        futureInstallments: null,
        closedUnpaid: null,
        overdue: null,
        forecast: null,
        grossDebt: null,
        appliedCredit: null,
        totalDebt: null,
        committed: null,
        available: null,
        credit: null,
        percentage: null,
        health: null,
      };
    }

    const today = todaySaoPaulo();
    const position = cardPosition(
      invoices,
      { closingDay: card.closingDay!, dueDay: card.dueDay! },
      today,
    );
    const committed = fromCents(position.totalDebtCents);
    const percentage = creditLimit ? (committed / creditLimit) * 100 : null;
    const current = invoices.find((i) => i.span.referenceMonth === position.current.referenceMonth);
    return {
      ...base,
      /** Total (cobranças efetivas − estornos) da fatura aberta hoje. */
      currentInvoice: fromCents(position.currentTotalCents),
      /** O que falta pagar dela, depois de pagamentos e créditos. */
      currentInvoiceRemaining: fromCents(position.currentRemainingCents),
      currentInvoiceId: current?.span.id ?? null,
      currentClosingDate: dayString(position.current.closingDate),
      currentDueDate: dayString(position.current.dueDate),
      /** Cobranças efetivas em faturas que fecham depois da atual (bruto). */
      futureCharges: fromCents(position.futureChargesCents),
      /** O que ainda falta pagar dessas faturas futuras (já sem o pago antecipado). */
      futureInstallments: fromCents(position.futureRemainingCents),
      /** Restante de faturas já fechadas. */
      closedUnpaid: fromCents(position.closedUnpaidCents),
      /** Restante de faturas com vencimento já passado. */
      overdue: fromCents(position.overdueCents),
      /** Cobranças previstas (assinaturas futuras): não são dívida nem consomem limite. */
      forecast: fromCents(position.forecastCents),
      /** Soma dos restantes antes dos créditos entre faturas. */
      grossDebt: fromCents(position.grossDebtCents),
      /** Créditos aplicados entre faturas. */
      appliedCredit: fromCents(position.appliedCreditCents),
      /** Dívida efetiva: o que falta pagar no cartão. */
      totalDebt: committed,
      /** Limite comprometido = dívida efetiva. */
      committed,
      /** Limite disponível estimado (crédito para novas compras, não saldo). */
      available: creditLimit !== null ? Math.max(0, creditLimit - committed) : null,
      /** Saldo credor: crédito sem cobrança onde ser aplicado. */
      credit: fromCents(position.creditCents),
      percentage,
      health: percentage !== null ? healthFromPercentage(percentage) : null,
    };
  }

  private async views(userId: string, cards: CardWithAccount[]) {
    const [amounts, user, opening] = await Promise.all([
      this.cardLedger.invoicesWithAmounts(cards.map((c) => c.id)),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { preferredAccountId: true },
      }),
      this.prisma.transaction.findMany({
        where: {
          accountId: { in: cards.map((c) => c.accountId) },
          type: { in: [...OPENING_TYPES] },
          status: 'confirmed',
        },
        select: {
          accountId: true,
          type: true,
          amount: true,
          invoice: { select: { dueDate: true } },
        },
      }),
    ]);
    return cards.map((c) =>
      this.toCardView(
        c,
        amounts.get(c.id),
        user?.preferredAccountId ?? null,
        opening.filter((o) => o.accountId === c.accountId),
      ),
    );
  }

  /** Cartões ativos; com `includeArchived`, também os arquivados (depois dos ativos). */
  async findAll(userId: string, includeArchived = false) {
    const cards = await this.prisma.creditCard.findMany({
      where: { account: { userId, ...(includeArchived ? {} : { isActive: true }) } },
      include: { account: true },
      orderBy: { createdAt: 'asc' },
    });
    return (await this.views(userId, cards)).sort(
      (a, b) => Number(b.isActive) - Number(a.isActive),
    );
  }

  async findOne(userId: string, id: string) {
    const [view] = await this.views(userId, [await this.findOwned(userId, id)]);
    return view;
  }

  /**
   * Resumo dos cartões. **Dívida e crédito** somam todos os cartões, inclusive
   * os arquivados — arquivar impede compras, não apaga o que se deve.
   * **Limite** é só dos ativos. Cartão sem configuração não entra na dívida e
   * é contado em `incompleteCards`: o total é parcial, não "zero".
   */
  async summary(userId: string) {
    const cards = await this.findAll(userId, true);
    const active = cards.filter((c) => c.isActive);
    const configured = cards.filter((c) => !c.needsSetup);
    const sum = (list: typeof cards, pick: (c: (typeof cards)[number]) => number | null) =>
      list.reduce((total, c) => total + Math.round((pick(c) ?? 0) * 100), 0) / 100;

    const totalDebt = sum(configured, (c) => c.totalDebt);
    const totalCurrentInvoices = sum(configured, (c) => c.currentInvoice);
    const totalLimit = sum(active, (c) => c.creditLimit);
    const totalCommitted = sum(
      active.filter((c) => !c.needsSetup),
      (c) => c.committed,
    );

    const today = todaySaoPaulo();
    const income = await this.prisma.transaction.aggregate({
      where: {
        userId,
        type: 'income',
        recurrenceType: 'fixo',
        status: { not: 'cancelled' },
        transactionDate: {
          gte: startOfMonthUtc(today.year, today.monthIndex),
          lte: endOfMonthUtc(today.year, today.monthIndex),
        },
      },
      _sum: { amount: true },
    });
    const monthlyIncome = Number(income._sum.amount ?? 0);
    // Renda do mês comparada às faturas do mês, não à dívida total (que inclui
    // parcelas de meses futuros).
    const incomePercentage =
      monthlyIncome > 0 ? (totalCurrentInvoices / monthlyIncome) * 100 : null;

    return {
      /** Dívida efetiva de todos os cartões configurados, inclusive arquivados. */
      totalDebt,
      /** Limite comprometido dos cartões ativos. */
      totalCommitted,
      totalCurrentInvoices,
      totalOverdue: sum(configured, (c) => c.overdue),
      totalFutureInstallments: sum(configured, (c) => c.futureInstallments),
      totalForecast: sum(configured, (c) => c.forecast),
      /** Saldo credor (crédito sem cobrança onde ser aplicado), por cartão somado. */
      totalCredit: sum(configured, (c) => c.credit),
      /** Limite dos cartões ativos. */
      totalLimit,
      totalAvailable: Math.max(0, totalLimit - totalCommitted),
      cardCount: active.length,
      archivedCount: cards.length - active.length,
      archivedWithDebtCount: cards.filter((c) => !c.isActive && (c.totalDebt ?? 0) > 0).length,
      pendingSetupCount: active.filter((c) => c.needsSetup).length,
      /** Cartões sem configuração (ativos ou não): a dívida deles é desconhecida. */
      incompleteCards: cards.filter((c) => c.needsSetup).length,
      monthlyIncome,
      incomePercentage,
      incomeHealth: incomePercentage !== null ? incomeHealthFromPercentage(incomePercentage) : null,
    };
  }

  /**
   * Conta interna e cartão nascem na mesma transação de banco: uma falha no
   * cartão não deixa uma conta `credit_card` órfã para trás.
   *
   * O controle de faturas começa no início do ciclo aberto hoje, não no dia da
   * criação: quem cadastra o cartão e lança as compras dos últimos dias espera
   * vê-las na fatura atual. O que se devia de ciclos anteriores entra pela
   * posição inicial (`setOpeningPosition`), não por suposição de quitação.
   */
  async create(userId: string, dto: CreateCreditCardDto) {
    await this.assertIndividual(userId);
    if (dto.paymentAccountId) await this.assertPaymentAccount(userId, dto.paymentAccountId);

    const card = await this.prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: { userId, name: dto.name, type: 'credit_card', initialBalance: 0, currentBalance: 0 },
      });
      return tx.creditCard.create({
        data: {
          accountId: account.id,
          brand: dto.brand ?? null,
          color: dto.color ?? null,
          creditLimit: dto.creditLimit ?? null,
          closingDay: dto.closingDay,
          dueDay: dto.dueDay,
          invoiceTrackingStart: toDbDate(
            configCycleFor(todaySaoPaulo(), { closingDay: dto.closingDay, dueDay: dto.dueDay })
              .periodStart,
          ),
          paymentAccountId: dto.paymentAccountId ?? null,
        },
        include: { account: true },
      });
    });
    return this.toCardView(card);
  }

  async update(userId: string, id: string, dto: UpdateCreditCardDto) {
    const existing = await this.findOwned(userId, id);
    const changesCycle =
      (dto.closingDay !== undefined && dto.closingDay !== existing.closingDay) ||
      (dto.dueDay !== undefined && dto.dueDay !== existing.dueDay);
    if ((dto.closingDay !== undefined || dto.dueDay !== undefined) && cardNeedsSetup(existing)) {
      throw new ConflictException(
        'Este cartão está com a configuração pendente. Configure o fechamento antes de alterar as datas.',
      );
    }
    if (dto.paymentAccountId) await this.assertPaymentAccount(userId, dto.paymentAccountId);

    const card = await this.prisma.$transaction(async (tx) => {
      if (dto.name !== undefined) {
        await tx.account.update({ where: { id: existing.accountId }, data: { name: dto.name } });
      }
      return tx.creditCard.update({
        where: { id: existing.id },
        data: {
          ...(dto.brand !== undefined && { brand: dto.brand }),
          ...(dto.color !== undefined && { color: dto.color }),
          ...(dto.creditLimit !== undefined && { creditLimit: dto.creditLimit }),
          ...(dto.closingDay !== undefined && { closingDay: dto.closingDay }),
          ...(dto.dueDay !== undefined && { dueDay: dto.dueDay }),
          ...(dto.paymentAccountId !== undefined && { paymentAccountId: dto.paymentAccountId }),
        },
        include: { account: true },
      });
    });

    // A fatura atual e as fechadas mantêm as datas; só as futuras são refeitas.
    if (changesCycle) await this.cardLedger.rebuildFutureInvoices(card);
    return this.findOne(userId, card.id);
  }

  /**
   * Configura um cartão pendente. O usuário escolhe a partir de quando os
   * lançamentos entram em fatura. Os anteriores ficam fora das faturas e da
   * dívida: **não** são tratados como quitados — o que ainda se devia deles é
   * informado na posição inicial.
   */
  async setup(userId: string, id: string, dto: SetupCreditCardDto) {
    const existing = await this.findOwned(userId, id);
    if (!cardNeedsSetup(existing)) {
      throw new ConflictException('Este cartão já está configurado');
    }
    const trackingStart = parseDateOnly(dto.invoiceTrackingStart.slice(0, 10));
    if (isFutureDay(trackingStart)) {
      throw new BadRequestException('O início do controle não pode ser uma data futura');
    }

    await this.prisma.$transaction(async (tx) => {
      await lockCreditCard(tx, existing.id);
      await tx.creditCard.update({
        where: { id: existing.id },
        data: {
          closingDay: dto.closingDay,
          dueDay: dto.dueDay,
          invoiceTrackingStart: trackingStart,
        },
      });
      await this.cardLedger.syncCardAccount(existing.accountId, tx);
      await this.accountsService.recalculateBalance(existing.accountId, tx);
    }, FINANCIAL_TX_OPTIONS);
    return this.findOne(userId, id);
  }

  /**
   * Registra (ou substitui) a posição do cartão no início do controle: a
   * fatura anterior ainda não paga e o crédito que havia.
   *
   * - A dívida vira um lançamento `opening_debt` numa fatura própria, anterior
   *   ao controle (fecha no início do controle, vence na data informada). Ela
   *   é paga, parcial ou totalmente, como qualquer fatura.
   * - Nada disso é despesa: as compras que formaram a dívida aconteceram antes
   *   do controle e, se forem importadas depois, ficam fora das faturas — a
   *   posição inicial não é contada duas vezes.
   * - Substituir cancela a posição anterior (o histórico fica) e grava a nova
   *   no mesmo commit.
   */
  async setOpeningPosition(userId: string, id: string, dto: OpeningPositionDto) {
    const card = await this.findOwned(userId, id);
    if (cardNeedsSetup(card)) {
      throw new ConflictException(
        'Configure o fechamento e o início do controle antes de informar a posição inicial.',
      );
    }
    const trackingStart = calendarDayFromUtcDate(card.invoiceTrackingStart!);
    const closingDate = trackingStart;
    const periodStart = closingDateIn(
      closingDate.year,
      closingDate.monthIndex - 1,
      card.closingDay!,
    );
    const dueDate = dto.previousInvoiceDueDate
      ? calendarDayFromUtcDate(parseDateOnly(dto.previousInvoiceDueDate.slice(0, 10)))
      : dueDateAfter(closingDate, card.dueDay!);
    if (compareCalendarDays(dueDate, closingDate) < 0) {
      throw new BadRequestException(
        'O vencimento da fatura anterior não pode ser antes do fechamento dela (o início do controle).',
      );
    }
    const referenceMonth = referenceMonthOf(dueDate);
    const debtCents = cents(dto.previousInvoiceAmount ?? 0);
    const creditCents = cents(dto.credit ?? 0);

    await this.prisma.$transaction(async (tx) => {
      await lockCreditCard(tx, card.id);
      const clash = await tx.creditCardInvoice.findFirst({
        where: {
          creditCardId: card.id,
          referenceMonth,
          closingDate: { gt: toDbDate(closingDate) },
        },
      });
      if (clash) {
        throw new BadRequestException(
          'O vencimento informado cai no mesmo mês de uma fatura já controlada. Confira a data.',
        );
      }

      // A posição anterior (se houver) sai; o histórico fica como cancelado.
      await tx.transaction.updateMany({
        where: { accountId: card.accountId, type: { in: [...OPENING_TYPES] }, status: 'confirmed' },
        data: { status: 'cancelled' },
      });

      if (debtCents > 0 || creditCents > 0) {
        const invoice = await tx.creditCardInvoice.upsert({
          where: { creditCardId_referenceMonth: { creditCardId: card.id, referenceMonth } },
          create: {
            userId,
            creditCardId: card.id,
            referenceMonth,
            periodStart: toDbDate(periodStart),
            closingDate: toDbDate(closingDate),
            dueDate: toDbDate(dueDate),
          },
          update: { dueDate: toDbDate(dueDate) },
        });
        // Dentro do ciclo anterior ao controle: a véspera do fechamento.
        const day = toDbDate(addDaysSaoPaulo(closingDate, -1));
        const base = {
          userId,
          accountId: card.accountId,
          transactionDate: day,
          eventDate: day,
          status: 'confirmed' as const,
          source: 'manual' as const,
          invoiceId: invoice.id,
        };
        if (debtCents > 0) {
          await tx.transaction.create({
            data: {
              ...base,
              type: 'opening_debt',
              amount: debtCents / 100,
              description: `Fatura anterior ao controle (${referenceMonth.slice(5)}/${referenceMonth.slice(0, 4)})`,
            },
          });
        }
        if (creditCents > 0) {
          await tx.transaction.create({
            data: {
              ...base,
              type: 'opening_credit',
              amount: creditCents / 100,
              description: 'Crédito anterior ao controle',
            },
          });
        }
      }

      // Fatura de posição inicial que ficou vazia e sem pagamento sai.
      await tx.creditCardInvoice.deleteMany({
        where: {
          creditCardId: card.id,
          closingDate: { lte: toDbDate(closingDate) },
          transactions: { none: { status: 'confirmed' } },
          payments: { none: {} },
        },
      });
      await this.accountsService.recalculateBalance(card.accountId, tx);
    }, FINANCIAL_TX_OPTIONS);

    return this.findOne(userId, id);
  }

  /** Faturas do cartão, da mais recente para a mais antiga, já conciliadas. */
  async invoices(userId: string, id: string) {
    const card = await this.findOwned(userId, id);
    if (cardNeedsSetup(card)) return [];
    const invoices = (await this.cardLedger.invoicesWithAmounts([card.id])).get(card.id) ?? [];
    const today = todaySaoPaulo();
    const { current, reconciliation } = cardPosition(
      invoices,
      { closingDay: card.closingDay!, dueDay: card.dueDay! },
      today,
    );
    const trackingStart = calendarDayFromUtcDate(card.invoiceTrackingStart!);
    return (reconciliation.invoices as ReconciledInvoice<StoredSpan>[])
      .map((row) => invoiceView(row, today, current, trackingStart))
      .reverse();
  }

  /**
   * Uma fatura com os lançamentos que a compõem (compras, parcelas, estornos e
   * posição inicial, em `items` — inclusive as previstas, marcadas) e os
   * pagamentos, ativos e revertidos (`paymentRecords`).
   */
  async invoice(userId: string, id: string, invoiceId: string) {
    const card = await this.findOwned(userId, id);
    const views = await this.invoices(userId, card.id);
    const view = views.find((v) => v.id === invoiceId);
    if (!view) throw new NotFoundException('Fatura não encontrada');

    const today = dateOnlyString(todaySaoPaulo());
    const [items, paymentRecords] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { invoiceId, status: 'confirmed', type: { in: [...INVOICE_ENTRY_TYPES] } },
        include: { category: { select: { id: true, name: true, color: true } } },
        orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.cardPayment.findMany({
        where: { invoiceId },
        include: { sourceAccount: { select: { id: true, name: true } } },
        orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    return {
      ...view,
      items: items.map((item) => ({
        ...item,
        /** Previsão: data do fato ainda não chegou — não é cobrança efetiva. */
        isForecast: item.eventDate.toISOString().slice(0, 10) > today,
      })),
      paymentRecords: paymentRecords.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        paymentDate: p.paymentDate.toISOString().slice(0, 10),
        status: p.status,
        reversedAt: p.reversedAt,
        sourceAccount: p.sourceAccount,
      })),
    };
  }

  /**
   * Arquiva o cartão. Cartão em uso tem lançamentos por definição — por isso
   * não passa pela regra de `AccountsService.deactivate` (desenhada para conta
   * comum, que recusa desativar conta com lançamentos). Arquivado, o cartão não
   * recebe compras, mas continua pagável e estornável, e a dívida dele
   * continua nos totais. Deixa de ser o preferencial dos lançamentos, se era.
   */
  async remove(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);

    await this.prisma.$transaction([
      this.prisma.account.update({
        where: { id: existing.accountId },
        data: { isActive: false },
      }),
      clearPreferredAccount(this.prisma, existing.accountId),
    ]);
    return { success: true };
  }

  private async findOwned(userId: string, id: string) {
    const card = await this.prisma.creditCard.findUnique({
      where: { id },
      include: { account: true },
    });
    if (!card || card.account.userId !== userId)
      throw new NotFoundException('Cartão não encontrado');
    return card;
  }

  /** Cartões existem só no perfil pessoal. */
  private async assertIndividual(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { profileType: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    if (user.profileType !== 'individual') {
      throw new ForbiddenException('Cartões de crédito estão disponíveis apenas no perfil pessoal');
    }
  }

  /** A conta de pagamento sugerida precisa ser uma conta comum ativa do usuário. */
  private async assertPaymentAccount(userId: string, accountId: string) {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (
      !account ||
      account.userId !== userId ||
      !account.isActive ||
      account.type === 'credit_card'
    ) {
      throw new BadRequestException('Conta de pagamento inválida');
    }
  }
}
