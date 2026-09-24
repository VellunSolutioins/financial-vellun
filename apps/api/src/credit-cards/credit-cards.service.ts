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
  compareCalendarDays,
  dateOnlyString,
  parseDateOnly,
  todaySaoPaulo,
  startOfMonthUtc,
  endOfMonthUtc,
  calendarDayFromUtcDate,
} from '../common/date.util';

import { healthFromPercentage, incomeHealthFromPercentage } from './card-health';
import { cardNeedsSetup } from './card-setup';
import { CardLedgerService, StoredSpan, toDbDate } from './card-ledger.service';
import { CreateCreditCardDto } from './dto/create-credit-card.dto';
import { SetupCreditCardDto } from './dto/setup-credit-card.dto';
import { UpdateCreditCardDto } from './dto/update-credit-card.dto';
import {
  InvoiceAmounts,
  InvoiceSpan,
  cardPosition,
  configCycleFor,
  cycleState,
  paymentStatus,
} from './invoice-cycle';

type CardWithAccount = Prisma.CreditCardGetPayload<{ include: { account: true } }>;

const fromCents = (cents: number) => cents / 100;

/** Dia-calendário como `YYYY-MM-DD`. */
const dayString = (day: CalendarDay) => dateOnlyString(day);

/** Valores de uma fatura, na forma exposta pela API. */
export function invoiceView(
  invoice: InvoiceAmounts<StoredSpan>,
  today: CalendarDay,
  current: InvoiceSpan,
) {
  const totalCents = invoice.chargesCents - invoice.refundsCents;
  const remainingCents = totalCents - invoice.paymentsCents;
  const { span } = invoice;
  return {
    id: span.id,
    referenceMonth: span.referenceMonth,
    periodStart: dayString(span.periodStart),
    closingDate: dayString(span.closingDate),
    dueDate: dayString(span.dueDate),
    /** `open` até a véspera do fechamento; depois, `closed`. */
    state: cycleState(span, today),
    isCurrent: span.referenceMonth === current.referenceMonth,
    isFuture: compareCalendarDays(span.closingDate, current.closingDate) > 0,
    charges: fromCents(invoice.chargesCents),
    refunds: fromCents(invoice.refundsCents),
    payments: fromCents(invoice.paymentsCents),
    total: fromCents(totalCents),
    remaining: fromCents(remainingCents),
    paymentStatus: paymentStatus(totalCents, invoice.paymentsCents),
  };
}

@Injectable()
export class CreditCardsService {
  constructor(
    private prisma: PrismaService,
    private cardLedger: CardLedgerService = new CardLedgerService(prisma),
  ) {}

  /**
   * Indicadores do cartão. Nada aqui usa `currentBalance`: fatura, dívida e
   * limite saem das faturas, desde o início do controle. Cartão com
   * configuração pendente não tem esses números — só o cadastro.
   */
  private toCardView(card: CardWithAccount, invoices: InvoiceAmounts<StoredSpan>[] = []) {
    const creditLimit = card.creditLimit ? Number(card.creditLimit) : null;
    const needsSetup = cardNeedsSetup(card);
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
      isActive: card.account.isActive,
      isPrimary: card.isPrimary,
    };
    if (needsSetup) {
      return {
        ...base,
        currentInvoice: null,
        currentInvoiceRemaining: null,
        currentInvoiceId: null,
        currentClosingDate: null,
        currentDueDate: null,
        futureInstallments: null,
        closedUnpaid: null,
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
      /** Total da fatura aberta hoje. */
      currentInvoice: fromCents(position.currentTotalCents),
      currentInvoiceRemaining: fromCents(position.currentRemainingCents),
      currentInvoiceId: current?.span.id ?? null,
      currentClosingDate: dayString(position.current.closingDate),
      currentDueDate: dayString(position.current.dueDate),
      /** Cobranças em faturas que fecham depois da atual. */
      futureInstallments: fromCents(position.futureInstallmentsCents),
      /** Restante de faturas já fechadas. */
      closedUnpaid: fromCents(position.closedUnpaidCents),
      totalDebt: committed,
      /** Limite comprometido = dívida total. */
      committed,
      /** Limite disponível (crédito para novas compras, não saldo). */
      available: creditLimit !== null ? Math.max(0, creditLimit - committed) : null,
      /** Pago acima do cobrado. */
      credit: fromCents(position.creditCents),
      percentage,
      health: percentage !== null ? healthFromPercentage(percentage) : null,
    };
  }

  private async views(cards: CardWithAccount[]) {
    const amounts = await this.cardLedger.invoicesWithAmounts(cards.map((c) => c.id));
    return cards.map((c) => this.toCardView(c, amounts.get(c.id)));
  }

  /** Cartões ativos; com `includeArchived`, também os arquivados (depois dos ativos). */
  async findAll(userId: string, includeArchived = false) {
    const cards = await this.prisma.creditCard.findMany({
      where: { account: { userId, ...(includeArchived ? {} : { isActive: true }) } },
      include: { account: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    return (await this.views(cards)).sort((a, b) => Number(b.isActive) - Number(a.isActive));
  }

  async findOne(userId: string, id: string) {
    const [view] = await this.views([await this.findOwned(userId, id)]);
    return view;
  }

  async summary(userId: string) {
    const cards = await this.findAll(userId);
    const configured = cards.filter((c) => !c.needsSetup);
    const totalCommitted = configured.reduce((sum, c) => sum + (c.committed ?? 0), 0);
    const totalCurrentInvoices = configured.reduce((sum, c) => sum + (c.currentInvoice ?? 0), 0);
    const totalLimit = cards.reduce((sum, c) => sum + (c.creditLimit ?? 0), 0);

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
      totalCommitted,
      totalCurrentInvoices,
      totalLimit,
      cardCount: cards.length,
      pendingSetupCount: cards.length - configured.length,
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
   * vê-las na fatura atual. Faturas de ciclos anteriores já fecharam fora do
   * app (ver docs/adrs/0014).
   */
  async create(userId: string, dto: CreateCreditCardDto) {
    await this.assertIndividual(userId);
    if (dto.paymentAccountId) await this.assertPaymentAccount(userId, dto.paymentAccountId);

    const card = await this.prisma.$transaction(async (tx) => {
      const existingCount = await tx.creditCard.count({
        where: { account: { userId, isActive: true } },
      });
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
          isPrimary: existingCount === 0,
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
   * lançamentos contam como dívida: os anteriores ficam "quitados antes do
   * controle" (fora de fatura, dívida e limite, mas no histórico); os
   * posteriores são atribuídos às faturas.
   */
  async setup(userId: string, id: string, dto: SetupCreditCardDto) {
    const existing = await this.findOwned(userId, id);
    if (!cardNeedsSetup(existing)) {
      throw new ConflictException('Este cartão já está configurado');
    }
    const trackingStart = parseDateOnly(dto.invoiceTrackingStart.slice(0, 10));
    if (compareCalendarDays(calendarDayFromUtcDate(trackingStart), todaySaoPaulo()) > 0) {
      throw new BadRequestException('O início do controle não pode ser uma data futura');
    }

    await this.prisma.creditCard.update({
      where: { id: existing.id },
      data: {
        closingDay: dto.closingDay,
        dueDay: dto.dueDay,
        invoiceTrackingStart: trackingStart,
      },
    });
    await this.cardLedger.syncCardAccount(existing.accountId);
    return this.findOne(userId, id);
  }

  /** Faturas do cartão, da mais recente para a mais antiga. */
  async invoices(userId: string, id: string) {
    const card = await this.findOwned(userId, id);
    if (cardNeedsSetup(card)) return [];
    const invoices = (await this.cardLedger.invoicesWithAmounts([card.id])).get(card.id) ?? [];
    const today = todaySaoPaulo();
    const { current } = cardPosition(
      invoices,
      { closingDay: card.closingDay!, dueDay: card.dueDay! },
      today,
    );
    return invoices.map((i) => invoiceView(i, today, current)).reverse();
  }

  /** Uma fatura com os lançamentos (compras e parcelas) que a compõem, em `items`. */
  async invoice(userId: string, id: string, invoiceId: string) {
    const card = await this.findOwned(userId, id);
    const views = await this.invoices(userId, card.id);
    const view = views.find((v) => v.id === invoiceId);
    if (!view) throw new NotFoundException('Fatura não encontrada');

    const items = await this.prisma.transaction.findMany({
      where: { invoiceId, status: 'confirmed', type: 'expense' },
      include: { category: { select: { id: true, name: true, color: true } } },
      orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }],
    });
    return { ...view, items };
  }

  async setPrimary(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);
    if (!existing.account.isActive) {
      throw new ConflictException('Cartão arquivado não pode ser o principal');
    }
    await this.prisma.$transaction([
      this.prisma.creditCard.updateMany({
        where: { account: { userId, isActive: true } },
        data: { isPrimary: false },
      }),
      this.prisma.creditCard.update({ where: { id: existing.id }, data: { isPrimary: true } }),
    ]);
    return this.findOne(userId, existing.id);
  }

  /**
   * Arquiva o cartão. Cartão em uso tem lançamentos por definição — por isso
   * não passa pela regra de `AccountsService.deactivate` (desenhada para conta
   * comum, que recusa desativar conta com lançamentos). Arquivado, o cartão não
   * recebe compras, mas o histórico continua consultável.
   */
  async remove(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id: existing.accountId }, data: { isActive: false } });
      await tx.creditCard.update({ where: { id: existing.id }, data: { isPrimary: false } });

      if (existing.isPrimary) {
        const nextPrimary = await tx.creditCard.findFirst({
          where: { account: { userId, isActive: true } },
          orderBy: { createdAt: 'asc' },
        });
        if (nextPrimary) {
          await tx.creditCard.update({ where: { id: nextPrimary.id }, data: { isPrimary: true } });
        }
      }
    });
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
