import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionAccessService } from '../billing/services/subscription-access.service';
import { SubscriptionRequiredException } from '../billing/subscription-required.exception';
import {
  addDaysSaoPaulo,
  dateOnlyString,
  startOfDayUtc,
  endOfDayUtc,
  todaySaoPaulo,
} from '../common/date.util';
import { DashboardService, periodBounds } from '../dashboard/dashboard.service';
import { CardPaymentsService } from '../credit-cards/card-payments.service';
import { CreateCardPaymentDto } from '../credit-cards/dto/create-card-payment.dto';
import { InstallmentsService } from '../transactions/installments.service';
import { SettlementsService } from '../transactions/settlements.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CreateSettlementDto } from '../transactions/dto/create-settlement.dto';
import { OpenItemsQueryDto } from './dto/open-items-query.dto';
import { UpdateEntryDto } from './dto/update-entry.dto';
import { SummaryQueryDto } from './dto/summary-query.dto';
import { fromBusinessSummary, fromPersonalSummary, WhatsappSummary } from './whatsapp-summary';

/** Até quantos dias à frente uma conta em aberto entra na busca de baixa. */
const OPEN_ITEMS_HORIZON_DAYS = 45;
/** Quantos dias para trás o agente procura o lançamento a corrigir ou excluir. */
const RECENT_DAYS = 30;
/** Teto da busca: o agente filtra por nome, valor e data. */
const RECENT_LIMIT = 300;
/** Correção e exclusão pelo WhatsApp só valem para receita e despesa. */
const EDITABLE_TYPES = ['income', 'expense'] as const;
const APP_ONLY = 'Esse tipo de lançamento só pode ser alterado no app.';

const recentInclude = {
  category: { select: { name: true } },
  account: { select: { name: true, type: true } },
} satisfies Prisma.TransactionInclude;
type RecentRow = Prisma.TransactionGetPayload<{ include: typeof recentInclude }>;

const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Ações do agente de WhatsApp sobre os dados do usuário (docs/plans/018).
 *
 * O `userId` vem do vínculo verificado do número, resolvido pelo agente com
 * `GET /internal/whatsapp/contacts/:phone`. Aqui não há regra financeira
 * nova: cada ação delega ao serviço que o app já usa.
 */
@Injectable()
export class InternalActionsService {
  constructor(
    private prisma: PrismaService,
    private subscriptionAccess: SubscriptionAccessService,
    private dashboard: DashboardService,
    private settlements: SettlementsService,
    private cardPayments: CardPaymentsService,
    private transactions: TransactionsService,
    private installments: InstallmentsService,
  ) {}

  /** Usuário existente e com direito de uso, como em `InternalService`. */
  private async userFor(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, profileType: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    if (this.subscriptionAccess.isEnforced()) {
      const access = await this.subscriptionAccess.canUseProduct(userId);
      if (!access.allowed) throw new SubscriptionRequiredException();
    }
    return user;
  }

  /** Resumo do período com os números do dashboard do perfil do usuário. */
  async summary(userId: string, query: SummaryQueryDto): Promise<WhatsappSummary> {
    const user = await this.userFor(userId);
    const { periodStart, periodEnd } = query;
    if (periodStart && periodEnd && periodStart > periodEnd) {
      throw new BadRequestException('O início do período não pode ser depois do fim');
    }

    if (user.profileType === 'business') {
      const bounds = periodBounds(periodStart, periodEnd);
      const summary = await this.dashboard.getBusinessSummary(userId, periodStart, periodEnd);
      return fromBusinessSummary(
        summary,
        {
          start: bounds.start.toISOString().slice(0, 10),
          end: bounds.end.toISOString().slice(0, 10),
        },
        dateOnlyString(todaySaoPaulo()),
      );
    }
    const [summary, receivables] = await Promise.all([
      this.dashboard.getSummary(userId, periodStart, periodEnd),
      this.dashboard.upcomingReceivables(userId),
    ]);
    return fromPersonalSummary(summary, receivables, dateOnlyString(todaySaoPaulo()));
  }

  /**
   * O que pode receber baixa pelo WhatsApp (Fase 2): lançamentos em aberto do
   * tipo pedido, vencidos ou a vencer em até 45 dias, e — para despesas — as
   * faturas com saldo. Uma ocorrência por série, como em "Contas a pagar".
   */
  async openItems(userId: string, query: OpenItemsQueryDto) {
    await this.userFor(userId);
    const horizon = dateOnlyString(addDaysSaoPaulo(todaySaoPaulo(), OPEN_ITEMS_HORIZON_DAYS));
    const { entries, invoices } = await this.dashboard.openItems(userId, query.type);
    const fallback = query.type === 'income' ? 'Receita' : 'Conta';
    return {
      entries: entries
        .filter((entry) => day(entry.transactionDate) <= horizon)
        .map((entry) => ({
          id: entry.id,
          description: entry.description || entry.category?.name || fallback,
          categoryName: entry.category?.name ?? null,
          /** O que falta pagar ou receber. */
          remaining: entry.remaining,
          dueDate: day(entry.transactionDate),
          isOverdue: entry.isOverdue,
          accountId: entry.accountId,
          accountName: entry.account?.name ?? null,
          /** No fixo, a baixa aceita valor maior que o previsto (é o valor real). */
          recurrenceType: entry.recurrenceType ?? null,
        })),
      // Só faturas já gravadas: o pagamento precisa do id da fatura.
      invoices: invoices
        .filter((invoice) => invoice.invoiceId)
        .map((invoice) => ({
          invoiceId: invoice.invoiceId!,
          cardId: invoice.cardId,
          cardName: invoice.cardName,
          remaining: invoice.remaining,
          dueDate: day(invoice.transactionDate),
          isOverdue: invoice.isOverdue,
          state: invoice.invoiceState,
        })),
    };
  }

  /** Paga ou recebe (total ou parcial) um lançamento em aberto. Idempotente pela chave. */
  async settle(userId: string, transactionId: string, dto: CreateSettlementDto) {
    await this.userFor(userId);
    return this.settlements.settle(userId, transactionId, dto);
  }

  /** Registra o pagamento de uma fatura. Idempotente pela chave. */
  async payInvoice(userId: string, cardId: string, invoiceId: string, dto: CreateCardPaymentDto) {
    await this.userFor(userId);
    return this.cardPayments.pay(userId, cardId, invoiceId, dto);
  }

  /**
   * Lançamentos que o agente pode corrigir ou excluir (Fase 3): receitas e
   * despesas confirmadas com data nos últimos 30 dias, ou registradas nesse
   * período (a parcela 2 de uma compra de ontem vence no mês que vem). Uma
   * linha por série: a ocorrência mais recente até hoje, ou a primeira
   * futura. Mais recentes (pela criação) primeiro.
   */
  async recentEntries(userId: string) {
    await this.userFor(userId);
    const today = dateOnlyString(todaySaoPaulo());
    const since = dateOnlyString(addDaysSaoPaulo(todaySaoPaulo(), -RECENT_DAYS));
    const rows = await this.prisma.transaction.findMany({
      where: {
        userId,
        status: 'confirmed',
        type: { in: [...EDITABLE_TYPES] },
        OR: [
          { transactionDate: { gte: startOfDayUtc(since), lte: endOfDayUtc(today) } },
          { createdAt: { gte: startOfDayUtc(since) } },
        ],
      },
      include: recentInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECENT_LIMIT,
    });
    return { entries: onePerSeries(rows, today).map(recentView) };
  }

  /**
   * Corrige valor, data, categoria, conta ou descrição. Lançamento pago à
   * vista continua pago (o pagamento acompanha a correção). Compra parcelada
   * se altera no app, em Parcelamentos.
   */
  async updateEntry(userId: string, transactionId: string, dto: UpdateEntryDto) {
    await this.userFor(userId);
    const entry = await this.ownedEntry(userId, transactionId);
    if (entry.recurrenceType === 'parcelado') {
      throw new ConflictException('Compra parcelada se altera no app, em Parcelamentos.');
    }
    await this.transactions.update(userId, transactionId, dto, { keepPaidInFull: true });
    const updated = await this.prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
      include: recentInclude,
    });
    return recentView(updated);
  }

  /** Exclui o lançamento (definitivo, como no app). Parcela: use a rota da compra. */
  async removeEntry(userId: string, transactionId: string) {
    await this.userFor(userId);
    await this.ownedEntry(userId, transactionId);
    return this.transactions.remove(userId, transactionId, true);
  }

  /** Exclui a compra parcelada inteira — todas as parcelas. */
  async removeInstallments(userId: string, seriesId: string) {
    await this.userFor(userId);
    return this.installments.remove(userId, seriesId);
  }

  /**
   * O lançamento do usuário que o agente pode mexer. De outro usuário é 404,
   * não 403: o agente não distingue "não existe" de "não é seu".
   */
  private async ownedEntry(userId: string, transactionId: string) {
    const entry = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
      select: { id: true, type: true, status: true, recurrenceType: true },
    });
    if (!entry) throw new NotFoundException('Lançamento não encontrado');
    if (
      !(EDITABLE_TYPES as readonly string[]).includes(entry.type) ||
      entry.status !== 'confirmed'
    ) {
      throw new ConflictException(APP_ONLY);
    }
    return entry;
  }
}

/**
 * Uma linha por série (fixo ou parcelado): a ocorrência mais recente até
 * hoje, senão a primeira futura. A ordem da lista é preservada.
 */
export function onePerSeries<T extends { seriesId: string | null; transactionDate: Date }>(
  rows: T[],
  today: string,
): T[] {
  const chosen = new Map<string, T>();
  for (const row of rows) {
    if (!row.seriesId) continue;
    const current = chosen.get(row.seriesId);
    if (!current || betterOccurrence(row, current, today)) chosen.set(row.seriesId, row);
  }
  return rows.filter((row) => !row.seriesId || chosen.get(row.seriesId) === row);
}

function betterOccurrence(
  candidate: { transactionDate: Date },
  current: { transactionDate: Date },
  today: string,
) {
  const a = day(candidate.transactionDate);
  const b = day(current.transactionDate);
  const aPast = a <= today;
  const bPast = b <= today;
  if (aPast !== bPast) return aPast;
  return aPast ? a > b : a < b;
}

function recentView(row: RecentRow) {
  const fallback = row.type === 'income' ? 'Receita' : 'Gasto';
  return {
    id: row.id,
    type: row.type,
    description: row.description || row.category?.name || fallback,
    amount: Number(row.amount),
    date: day(row.transactionDate),
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    accountId: row.accountId,
    accountName: row.account.name,
    /** No cartão, a compra é paga pela fatura: não tem pagamento próprio. */
    onCard: row.account.type === 'credit_card',
    /** Quanto já foi pago ou recebido. */
    settledAmount: Number(row.settledAmount),
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    recurrenceType: row.recurrenceType,
    /** Na compra parcelada, o id da compra (rota de exclusão). */
    seriesId: row.seriesId,
    installmentNumber: row.installmentNumber,
    installmentTotal: row.installmentTotal,
  };
}
