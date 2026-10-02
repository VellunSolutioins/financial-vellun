import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { ListTransactionsDto, TransactionFiltersDto } from './dto/list-transactions.dto';
import { RefundTransactionDto } from './dto/refund-transaction.dto';
import { ResourceScope, scopeWhere } from '../common/resource-scope';
import { CardLedgerService } from '../credit-cards/card-ledger.service';
import { NET_EXPENSE_TYPES, netExpenseByCategory, netExpenseOf, roundCents } from './net-expense';
import {
  calendarDayFromUtcDate,
  compareCalendarDays,
  dateOnlyString,
  endOfDayUtc,
  isFutureDay,
  parseDateOnly,
  startOfDayUtc,
  todaySaoPaulo,
} from '../common/date.util';
import { Db, FINANCIAL_TX_OPTIONS, cents, lockAccounts, lockTransaction } from '../common/db';
import { writeEntrySeries } from './entry-writer';
import { recordSettlement } from './settlements.service';
import {
  realizedSpendingFilter,
  settlementWhere,
  spendingPeriodWhere,
  withSettlementInfo,
} from './settlement-state';

const entryInclude = { category: true, account: true } satisfies Prisma.TransactionInclude;

type Entry = Prisma.TransactionGetPayload<{ include: typeof entryInclude }>;

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private prisma: PrismaService,
    private accountsService: AccountsService,
    private resourceScope: ResourceScope = new ResourceScope(prisma),
    private cardLedger: CardLedgerService = new CardLedgerService(prisma),
  ) {}

  /**
   * Filtro comum da listagem e dos totais; valida o recorte por conta/cartão.
   *
   * O período vale para a **data do vencimento/ocorrência** (`dateBasis=due`,
   * o padrão da listagem) ou para a **data do fato** (`dateBasis=event`, a de
   * "Gastos por data da compra"). As duas nunca se misturam numa consulta.
   */
  private async buildWhere(
    userId: string,
    filters: TransactionFiltersDto,
  ): Promise<Prisma.TransactionWhereInput> {
    const {
      periodStart,
      periodEnd,
      type,
      categoryId,
      accountId,
      status,
      source,
      recurrenceType,
      search,
      settlement,
      forecast,
      realizedOnly,
      dateBasis = 'due',
    } = filters;
    const scoped = await this.resourceScope.resolve(userId, filters);
    const dateColumn = dateBasis === 'event' ? 'eventDate' : 'transactionDate';

    return {
      userId,
      ...(type && { type }),
      ...(categoryId === 'uncategorized' ? { categoryId: null } : categoryId ? { categoryId } : {}),
      // `accountId` (legado, um só), o recorte por recursos e o estado de
      // liquidação se somam.
      AND: [
        accountId ? { accountId } : {},
        scopeWhere(scoped),
        settlement ? settlementWhere(settlement, this.prisma.transaction.fields.amount) : {},
        realizedOnly ? realizedSpendingFilter(endOfDayUtc(dateOnlyString(todaySaoPaulo()))) : {},
        // Mês do gasto: a parcela no dela, o resto na data do fato (ADR 0019).
        dateBasis === 'spending' && (periodStart || periodEnd)
          ? spendingPeriodWhere(
              periodStart ? startOfDayUtc(periodStart) : new Date(0),
              periodEnd ? endOfDayUtc(periodEnd) : new Date('9999-12-31'),
            )
          : {},
      ],
      ...(status && { status }),
      ...(source && { source }),
      ...(recurrenceType && { recurrenceType }),
      ...(forecast !== undefined && { forecast }),
      ...(search && { description: { contains: search, mode: 'insensitive' } }),
      ...(dateBasis !== 'spending' && (periodStart || periodEnd)
        ? {
            [dateColumn]: {
              ...(periodStart && { gte: startOfDayUtc(periodStart) }),
              ...(periodEnd && { lte: endOfDayUtc(periodEnd) }),
            },
          }
        : {}),
    };
  }

  async findAll(userId: string, filters: ListTransactionsDto) {
    const { page = 1, limit = 10, sortBy = 'transactionDate', order = 'desc' } = filters;
    const where = await this.buildWhere(userId, filters);

    const validSortFields: Record<string, string> = {
      transactionDate: 'transactionDate',
      eventDate: 'eventDate',
      amount: 'amount',
      description: 'description',
      createdAt: 'createdAt',
    };
    const orderByField = validSortFields[sortBy] ?? 'transactionDate';

    const [data, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        include: entryInclude,
        // Desempate estável: vários lançamentos no mesmo dia sem critério
        // secundário podem repetir ou sumir entre páginas.
        orderBy: [{ [orderByField]: order }, { createdAt: order }, { id: order }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    const today = todaySaoPaulo();
    return {
      data: data.map((t) => withSettlementInfo(t, today)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Totais dos lançamentos que a listagem mostraria com os mesmos filtros —
   * todas as páginas, não só a atual. Só confirmados entram na soma: com o
   * filtro `status=cancelled`, os totais são zero. Despesa é líquida de
   * estornos; pernas de transferência e de pagamento de fatura e a posição
   * inicial do cartão não são receita nem despesa.
   *
   * `openIncome`/`openExpense` são o que ainda falta receber/pagar (em conta
   * comum) entre esses lançamentos.
   *
   * Os blocos da tela (docs/adrs/0020) leem o dinheiro, não o lançado:
   * `received`/`paid` somam só liquidações `payment` ativas em conta comum
   * (dispensa não é dinheiro) — `paid` inclui as faturas pagas e desconta
   * estornos recebidos —; `onCard` é o que foi comprado no cartão e só vira
   * `paid` quando a fatura é paga; `leftover` = recebido − pago.
   */
  async summary(userId: string, filters: TransactionFiltersDto) {
    const base = await this.buildWhere(userId, filters);
    const where: Prisma.TransactionWhereInput = {
      AND: [base, { status: 'confirmed', type: { in: ['income', ...NET_EXPENSE_TYPES] } }],
    };
    const onRegularAccount = { account: { type: { not: 'credit_card' as const } } };
    const settledOf = (type: 'income' | 'expense' | 'refund') =>
      this.prisma.transactionSettlement.aggregate({
        where: {
          status: 'active',
          kind: 'payment',
          transaction: { AND: [where, { type }, onRegularAccount] },
        },
        _sum: { amount: true },
      });

    const [
      byType,
      byCategory,
      open,
      settledIncome,
      settledExpense,
      settledRefund,
      invoicePayments,
      onCardByType,
    ] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['type'],
        where,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['type', 'categoryId'],
        where,
        _sum: { amount: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: {
          AND: [where, settlementWhere('open', this.prisma.transaction.fields.amount)],
        },
        _sum: { amount: true, settledAmount: true },
      }),
      settledOf('income'),
      settledOf('expense'),
      settledOf('refund'),
      // Perna de saída do pagamento de fatura: cai no mês em que a fatura foi paga.
      this.prisma.transaction.aggregate({
        where: {
          AND: [
            base,
            {
              status: 'confirmed',
              type: 'transfer',
              transferDirection: 'out',
              cardPaymentId: { not: null },
            },
          ],
        },
        _sum: { amount: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: { AND: [where, { account: { type: 'credit_card' } }] },
        _sum: { amount: true },
      }),
    ]);

    const income = Number(byType.find((row) => row.type === 'income')?._sum.amount ?? 0);
    const expense = roundCents(netExpenseOf(byType));
    const expenseByCategory = netExpenseByCategory(byCategory);
    const openOf = (type: string) => {
      const row = open.find((r) => r.type === type);
      return (cents(row?._sum.amount) - cents(row?._sum.settledAmount)) / 100;
    };

    const categoryIds = byCategory.map((row) => row.categoryId).filter(Boolean) as string[];
    const categories = await this.prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true, color: true, nature: true },
    });
    const categoryById = new Map(categories.map((c) => [c.id, c]));

    const receivedCents = cents(settledIncome._sum.amount);
    const paidCents =
      cents(settledExpense._sum.amount) -
      cents(settledRefund._sum.amount) +
      cents(invoicePayments._sum.amount);

    return {
      dateBasis: filters.dateBasis ?? 'due',
      income,
      expense,
      net: roundCents(income - expense),
      openIncome: openOf('income'),
      openExpense: openOf('expense'),
      received: receivedCents / 100,
      toReceive: openOf('income'),
      paid: paidCents / 100,
      toPay: openOf('expense'),
      onCard: roundCents(netExpenseOf(onCardByType)),
      leftover: (receivedCents - paidCents) / 100,
      count: byType.reduce((sum, row) => sum + row._count._all, 0),
      byCategory: [
        ...byCategory
          .filter((row) => row.type === 'income')
          .map((row) => ({
            type: 'income' as const,
            categoryId: row.categoryId,
            total: Number(row._sum.amount ?? 0),
          })),
        ...[...expenseByCategory].map(([categoryId, total]) => ({
          type: 'expense' as const,
          categoryId,
          total: roundCents(total),
        })),
      ]
        .map((row) => {
          const category = row.categoryId ? categoryById.get(row.categoryId) : undefined;
          const typeTotal = row.type === 'income' ? income : expense;
          return {
            ...row,
            categoryName: category?.name ?? 'Sem categoria',
            color: category?.color ?? null,
            nature: category?.nature ?? 'consumption',
            percentage: typeTotal > 0 ? (row.total / typeTotal) * 100 : 0,
          };
        })
        .sort((a, b) => b.total - a.total),
    };
  }

  async findOne(userId: string, id: string, db: Db = this.prisma) {
    const transaction = await db.transaction.findUnique({
      where: { id },
      include: entryInclude,
    });
    if (!transaction) throw new NotFoundException('Lançamento não encontrado');
    if (transaction.userId !== userId) throw new ForbiddenException();
    return withSettlementInfo(transaction);
  }

  /**
   * Cria o lançamento (ou a série) com a compra parcelada, a liquidação à
   * vista, o saldo e a fatura **no mesmo commit**: uma falha no meio não deixa
   * saldo nem fatura inconsistentes. Com `idempotencyKey`, o duplo clique
   * devolve o lançamento já criado.
   */
  async create(userId: string, dto: CreateTransactionDto) {
    if (dto.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(userId, dto.idempotencyKey);
      if (existing) return existing;
    }
    assertInstallmentIsExpense(dto.type, dto.recurrenceType);
    const account = await this.validateOwnership(userId, dto.accountId, dto.categoryId, dto.type);

    let firstId: string;
    try {
      firstId = await this.prisma.$transaction(async (tx) => {
        await lockAccounts(tx, [dto.accountId]);
        const { rows } = await writeEntrySeries(tx, {
          userId,
          account: account!,
          categoryId: dto.categoryId || null,
          type: dto.type,
          description: dto.description,
          source: 'manual',
          recurrenceType: dto.recurrenceType,
          recurrenceFrequency: dto.recurrenceFrequency,
          installments: dto.installments,
          recurrenceMonths: dto.recurrenceMonths,
          amount: dto.amount,
          firstDate: parseDateOnly(dto.transactionDate.slice(0, 10)),
          eventDate: dto.eventDate ? parseDateOnly(dto.eventDate.slice(0, 10)) : undefined,
          forecast: dto.forecast,
          settle: dto.settle,
          settlementOrigin: 'at_sight',
          idempotencyKey: dto.idempotencyKey,
        });
        await this.accountsService.recalculateBalance(dto.accountId, tx);
        await this.cardLedger.syncTransactions(
          rows.map((t) => t.id),
          tx,
        );
        return rows[0].id;
      }, FINANCIAL_TX_OPTIONS);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        dto.idempotencyKey
      ) {
        const raced = await this.findByIdempotencyKey(userId, dto.idempotencyKey);
        if (raced) return raced;
      }
      throw err;
    }

    return this.findOne(userId, firstId);
  }

  async update(userId: string, id: string, dto: UpdateTransactionDto) {
    const existing = await this.findOne(userId, id);
    if (dto.type !== undefined && dto.type !== existing.type) {
      assertInstallmentIsExpense(dto.type, existing.recurrenceType ?? undefined);
    }
    await this.assertValueChangeAllowed(existing, dto);

    // A conta só é revalidada quando muda: editar a descrição de um lançamento
    // de cartão arquivado continua permitido.
    const accountChanged = dto.accountId !== undefined && dto.accountId !== existing.accountId;
    if (accountChanged || dto.categoryId !== undefined || dto.type !== undefined) {
      await this.validateOwnership(
        userId,
        accountChanged ? dto.accountId : undefined,
        dto.categoryId,
        dto.type,
        existing.accountId,
      );
    }

    const categoryId = dto.categoryId === '' ? null : dto.categoryId;
    const transactionDate = dto.transactionDate
      ? parseDateOnly(dto.transactionDate.slice(0, 10))
      : undefined;
    const eventDate = this.nextEventDate(existing, dto, transactionDate);

    await this.prisma.$transaction(async (tx) => {
      await lockTransaction(tx, id);
      await lockAccounts(tx, [existing.accountId, dto.accountId]);
      await tx.transaction.update({
        where: { id },
        data: {
          ...(dto.type !== undefined && { type: dto.type }),
          ...(dto.amount !== undefined && { amount: dto.amount }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.accountId !== undefined && { accountId: dto.accountId }),
          ...(dto.status !== undefined && { status: dto.status }),
          ...(dto.forecast !== undefined && { forecast: dto.forecast }),
          ...(categoryId !== undefined && { categoryId }),
          ...(transactionDate && { transactionDate }),
          ...(eventDate && { eventDate }),
        },
      });

      await this.accountsService.recalculateBalance(existing.accountId, tx);
      if (accountChanged) await this.accountsService.recalculateBalance(dto.accountId!, tx);
      // Data, valor, conta ou status podem mudar a fatura (ou tirá-la dela).
      await this.cardLedger.syncTransactions([id], tx);
      await this.cardLedger.pruneForAccount(existing.accountId, tx);
    }, FINANCIAL_TX_OPTIONS);

    return this.findOne(userId, id);
  }

  /**
   * Data do fato depois de uma edição. Na parcela, é a da compra e só muda
   * pela compra. No avulso, acompanha o vencimento enquanto os dois eram
   * iguais (ninguém tinha separado o fato do vencimento); no fixo, é sempre
   * a data da ocorrência.
   */
  private nextEventDate(
    existing: Entry,
    dto: UpdateTransactionDto,
    transactionDate: Date | undefined,
  ): Date | undefined {
    if (existing.purchaseId) {
      if (dto.eventDate) {
        throw new BadRequestException(
          'A data da compra vale para todas as parcelas: altere-a em Parcelamentos.',
        );
      }
      return undefined;
    }
    if (dto.eventDate) return parseDateOnly(dto.eventDate.slice(0, 10));
    if (!transactionDate) return undefined;
    const sameAsDue =
      existing.eventDate.toISOString().slice(0, 10) ===
      existing.transactionDate.toISOString().slice(0, 10);
    return existing.recurrenceType === 'fixo' || sameAsDue ? transactionDate : undefined;
  }

  async remove(userId: string, id: string, hardDelete = false) {
    const transaction = await this.findOne(userId, id);
    const reason = (await this.cardLedger.lockReasons([transaction])).get(id);
    if (reason) throw new ConflictException(reason);
    if (await this.hasRefunds(id)) {
      throw new ConflictException(
        'Esta compra tem estornos. Para desfazê-la, estorne o valor restante em vez de excluir.',
      );
    }
    assertNoActiveSettlement(transaction, 'excluído');

    await this.prisma.$transaction(async (tx) => {
      await lockTransaction(tx, id);
      await lockAccounts(tx, [transaction.accountId]);
      // Relido sob a trava: um pagamento pode ter entrado desde a checagem.
      const current = await tx.transaction.findUniqueOrThrow({ where: { id } });
      assertNoActiveSettlement(current, 'excluído');
      if (hardDelete) {
        await tx.transaction.delete({ where: { id } });
      } else {
        await tx.transaction.update({ where: { id }, data: { status: 'cancelled' } });
        await this.cardLedger.syncTransactions([id], tx);
      }
      await this.accountsService.recalculateBalance(transaction.accountId, tx);
      await this.cardLedger.pruneForAccount(transaction.accountId, tx);
    }, FINANCIAL_TX_OPTIONS);
    return { message: 'Lançamento removido com sucesso' };
  }

  /**
   * Estorno de uma despesa. `single`: um estorno de `amount`, na data. No
   * cartão, cai na fatura aberta nessa data; em conta comum, é entrada de
   * dinheiro (liquidação à vista), não receita — e só do que já foi pago:
   * reduzir o que ainda não foi pago é editar o valor ou dispensar o restante.
   * `series` (compra parcelada): parcelas ainda não cobradas são canceladas;
   * as já cobradas são estornadas por inteiro.
   */
  async refund(userId: string, id: string, dto: RefundTransactionDto) {
    const original = await this.findOne(userId, id);
    if (original.type !== 'expense' || original.status !== 'confirmed') {
      throw new BadRequestException('Só uma despesa confirmada pode ser estornada');
    }
    const date = parseDateOnly(dto.date.slice(0, 10));
    // Estorno é algo que já aconteceu, como o pagamento da fatura. Datado no
    // futuro, entrava numa fatura que ainda nem abriu.
    if (isFutureDay(date)) {
      throw new BadRequestException('A data do estorno não pode ser futura');
    }

    if (dto.scope === 'series') return this.refundSeries(userId, original, date);

    if (dto.amount === undefined) throw new BadRequestException('Informe o valor do estorno');
    const refund = await this.prisma.$transaction(async (tx) => {
      await lockTransaction(tx, original.id);
      await lockAccounts(tx, [original.accountId]);
      const current = await tx.transaction.findUniqueOrThrow({
        where: { id: original.id },
        include: { account: { select: { type: true } } },
      });
      const refundableCents = await this.refundableCents(current, tx);
      if (cents(dto.amount) > refundableCents) {
        throw new BadRequestException(
          current.account.type === 'credit_card'
            ? `O estorno passa do valor ainda não estornado da compra (R$ ${(refundableCents / 100).toFixed(2)})`
            : `O estorno passa do que foi pago e ainda não estornado (R$ ${(refundableCents / 100).toFixed(2)}). Para reduzir o que ainda não foi pago, edite o valor ou dispense o restante.`,
        );
      }
      const created = await this.createRefund(tx, userId, current, cents(dto.amount!), date);
      await this.accountsService.recalculateBalance(original.accountId, tx);
      await this.cardLedger.syncTransactions([created.id], tx);
      return created;
    }, FINANCIAL_TX_OPTIONS);
    return { refunds: [await this.findOne(userId, refund.id)], cancelled: [] as string[] };
  }

  private async refundSeries(userId: string, original: Entry, date: Date) {
    if (original.recurrenceType !== 'parcelado' || !original.seriesId) {
      throw new BadRequestException('Estorno da série só vale para compra parcelada');
    }
    const isCard = original.account.type === 'credit_card';
    const result = await this.prisma.$transaction(async (tx) => {
      await lockAccounts(tx, [original.accountId]);
      const installments = await tx.transaction.findMany({
        where: { userId, seriesId: original.seriesId, type: 'expense', status: 'confirmed' },
        include: { account: { select: { type: true } } },
        orderBy: { installmentNumber: 'asc' },
      });
      const locked = await this.cardLedger.lockReasons(installments, tx);
      const today = todaySaoPaulo();

      const toCancel: string[] = [];
      const created: string[] = [];
      for (const installment of installments) {
        // Já cobrada: no cartão, fatura fechada ou paga (sem fatura, a data já
        // passou); em conta comum, já tem pagamento.
        const billed = installment.invoiceId
          ? locked.has(installment.id)
          : isCard
            ? compareCalendarDays(calendarDayFromUtcDate(installment.transactionDate), today) <= 0
            : cents(installment.settledAmount) > 0;
        if (!billed) {
          toCancel.push(installment.id);
          continue;
        }
        const refundable = await this.refundableCents(installment, tx);
        if (refundable > 0) {
          created.push((await this.createRefund(tx, userId, installment, refundable, date)).id);
        }
      }
      await tx.transaction.updateMany({
        where: { id: { in: toCancel } },
        data: { status: 'cancelled' },
      });
      await this.accountsService.recalculateBalance(original.accountId, tx);
      await this.cardLedger.syncTransactions([...toCancel, ...created], tx);
      await this.cardLedger.pruneForAccount(original.accountId, tx);
      return { created, toCancel };
    }, FINANCIAL_TX_OPTIONS);
    const refunds = await this.prisma.transaction.findMany({
      where: { id: { in: result.created } },
      include: entryInclude,
    });
    return { refunds: refunds.map((r) => withSettlementInfo(r)), cancelled: result.toCancel };
  }

  /** Grava o estorno; em conta comum, com a entrada do dinheiro já liquidada. */
  private async createRefund(
    tx: Db,
    userId: string,
    original: {
      id: string;
      accountId: string;
      categoryId: string | null;
      description: string;
      installmentNumber: number | null;
      installmentTotal: number | null;
      account: { type: string };
    },
    amountCents: number,
    date: Date,
  ) {
    const installment = original.installmentTotal
      ? ` (${original.installmentNumber}/${original.installmentTotal})`
      : '';
    const refund = await tx.transaction.create({
      data: {
        userId,
        accountId: original.accountId,
        // Mesma categoria da compra: o estorno abate a despesa dela.
        categoryId: original.categoryId,
        type: 'refund',
        amount: amountCents / 100,
        description: `Estorno: ${original.description}${installment}`,
        transactionDate: date,
        eventDate: date,
        status: 'confirmed',
        source: 'manual',
        refundOfId: original.id,
      },
    });
    if (original.account.type !== 'credit_card') {
      await recordSettlement(tx, {
        userId,
        transactionId: refund.id,
        accountId: original.accountId,
        amountCents,
        date,
        origin: 'at_sight',
      });
    }
    return refund;
  }

  /**
   * Quanto ainda pode ser estornado, em centavos. No cartão, o valor da compra
   * menos os estornos. Em conta comum, o que foi **pago** menos os estornos:
   * estornar o que não saiu da conta seria criar dinheiro.
   */
  private async refundableCents(
    original: {
      id: string;
      amount: Prisma.Decimal | number;
      settledAmount: Prisma.Decimal | number;
      account: { type: string };
    },
    db: Db = this.prisma,
  ) {
    const refunded = await db.transaction.aggregate({
      where: { refundOfId: original.id, status: 'confirmed' },
      _sum: { amount: true },
    });
    const base =
      original.account.type === 'credit_card'
        ? cents(original.amount)
        : cents(original.settledAmount);
    return Math.max(0, base - cents(refunded._sum.amount));
  }

  private async hasRefunds(id: string) {
    return (
      (await this.prisma.transaction.count({ where: { refundOfId: id, status: 'confirmed' } })) > 0
    );
  }

  /**
   * Regras de alteração (docs/adrs/0015 e 0018): valor, data, conta, tipo e
   * status só mudam enquanto o lançamento não estiver travado pela fatura, por
   * um pagamento ou por ser perna de movimentação; estorno e perna não trocam
   * de tipo; compra com estorno não fica abaixo do valor estornado nem é
   * cancelada; lançamento com pagamento registrado não troca de conta nem de
   * tipo, não é cancelado e não fica abaixo do que já foi pago.
   */
  private async assertValueChangeAllowed(existing: Entry, dto: UpdateTransactionDto) {
    const changesValue =
      (dto.amount !== undefined && Number(dto.amount) !== Number(existing.amount)) ||
      (dto.transactionDate !== undefined &&
        parseDateOnly(dto.transactionDate.slice(0, 10)).toISOString().slice(0, 10) !==
          existing.transactionDate.toISOString().slice(0, 10)) ||
      (dto.accountId !== undefined && dto.accountId !== existing.accountId) ||
      (dto.type !== undefined && dto.type !== existing.type) ||
      (dto.status !== undefined && dto.status !== existing.status);
    if (!changesValue) return;

    if (
      dto.type !== undefined &&
      dto.type !== existing.type &&
      !['income', 'expense'].includes(existing.type)
    ) {
      throw new ConflictException('Estorno, transferência e pagamento de fatura não mudam de tipo');
    }
    const reason = (await this.cardLedger.lockReasons([existing])).get(existing.id);
    if (reason) throw new ConflictException(reason);

    if (await this.hasRefunds(existing.id)) {
      const refundedCents =
        cents(existing.amount) -
        (await this.refundableCents({ ...existing, settledAmount: existing.amount }));
      const cancels = dto.status === 'cancelled';
      const belowRefunded = dto.amount !== undefined && cents(dto.amount) < refundedCents;
      if (cancels || belowRefunded || (dto.type !== undefined && dto.type !== existing.type)) {
        throw new ConflictException(
          'Esta compra tem estornos: não pode ser cancelada, trocar de tipo nem ficar abaixo do valor estornado.',
        );
      }
    }

    const settledCents = cents(existing.settledAmount);
    if (settledCents > 0) {
      if (dto.status === 'cancelled') assertNoActiveSettlement(existing, 'cancelado');
      if (
        (dto.accountId !== undefined && dto.accountId !== existing.accountId) ||
        (dto.type !== undefined && dto.type !== existing.type)
      ) {
        throw new ConflictException(
          'Este lançamento já tem pagamento registrado: para trocar a conta ou o tipo, reverta os pagamentos antes.',
        );
      }
      if (dto.amount !== undefined && cents(dto.amount) < settledCents) {
        throw new ConflictException(
          `O valor não pode ficar abaixo do que já foi pago (R$ ${(settledCents / 100).toFixed(2)}).`,
        );
      }
    }
  }

  async findAiAudit(userId: string, id: string) {
    await this.findOne(userId, id);

    const extractions = await this.prisma.aiExtractedTransaction.findMany({
      where: { transactionId: id, userId },
      orderBy: { createdAt: 'desc' },
    });

    if (extractions.length === 0) {
      throw new NotFoundException('Nenhuma extração de IA associada a este lançamento');
    }

    return extractions;
  }

  private async findByIdempotencyKey(userId: string, idempotencyKey: string) {
    const existing = await this.prisma.transaction.findUnique({
      where: { idempotencyKey },
      include: entryInclude,
    });
    if (!existing) return null;
    if (existing.userId !== userId) {
      this.logger.error('Chave de idempotência de lançamento reaproveitada por outro usuário');
      throw new ConflictException('Chave de idempotência já utilizada');
    }
    return { ...withSettlementInfo(existing), idempotent: true };
  }

  /**
   * Conta e categoria precisam ser do usuário, e a conta precisa estar ativa —
   * cartão arquivado não recebe compra. Cartão não recebe receita (devolução
   * é estorno). Usado também pelas recorrências. `currentAccountId` é a conta
   * atual do lançamento, quando ele só troca de tipo. Devolve a conta
   * validada, quando informada.
   */
  async validateOwnership(
    userId: string,
    accountId?: string,
    categoryId?: string,
    type?: string,
    currentAccountId?: string,
  ) {
    let validated: { id: string; type: string } | null = null;
    if (accountId !== undefined) {
      if (!accountId) throw new BadRequestException('Conta inválida');
      const account = await this.prisma.account.findUnique({ where: { id: accountId } });
      if (!account || account.userId !== userId) {
        throw new BadRequestException('Conta inválida');
      }
      assertAccountAcceptsEntries(account);
      validated = { id: account.id, type: account.type };
    }
    if (type === 'income') {
      const target = accountId ?? currentAccountId;
      const account = target
        ? await this.prisma.account.findUnique({ where: { id: target }, select: { type: true } })
        : null;
      assertAccountAcceptsType(account, type);
    }
    if (categoryId) {
      const category = await this.prisma.category.findUnique({ where: { id: categoryId } });
      if (!category || (category.userId !== null && category.userId !== userId)) {
        throw new BadRequestException('Categoria inválida');
      }
    }
    return validated;
  }
}

/** Lançamento com pagamento ativo não é excluído nem cancelado: reverta antes. */
function assertNoActiveSettlement(
  transaction: { settledAmount: Prisma.Decimal | number },
  action: string,
) {
  if (cents(transaction.settledAmount) > 0) {
    throw new ConflictException(
      `Este lançamento já tem pagamento registrado e não pode ser ${action}. Reverta os pagamentos antes.`,
    );
  }
}

/**
 * Parcelamento só existe para despesa (docs/adrs/0020). Receitas parceladas
 * gravadas antes continuam funcionando; só não nascem novas.
 */
export function assertInstallmentIsExpense(type: string | undefined, recurrenceType?: string) {
  if (recurrenceType === 'parcelado' && type === 'income') {
    throw new BadRequestException('Parcelamento só existe para despesas.');
  }
}

/** Cartão não recebe receita: devolução de compra é estorno. */
export function assertAccountAcceptsType(account: { type: string } | null, type: string) {
  if (account?.type === 'credit_card' && type === 'income') {
    throw new BadRequestException(
      'Cartão não recebe receita. Para devolução de uma compra, use o estorno.',
    );
  }
}

/** Conta desativada ou cartão arquivado não recebem lançamento novo. */
export function assertAccountAcceptsEntries(account: { isActive: boolean; type: string }) {
  if (account.isActive) return;
  throw new BadRequestException(
    account.type === 'credit_card'
      ? 'Cartão arquivado não recebe novas compras'
      : 'Conta desativada não recebe novos lançamentos',
  );
}

export { installmentAmounts } from './recurrence-series';
