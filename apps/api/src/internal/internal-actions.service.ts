import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionAccessService } from '../billing/services/subscription-access.service';
import { SubscriptionRequiredException } from '../billing/subscription-required.exception';
import { addDaysSaoPaulo, dateOnlyString, todaySaoPaulo } from '../common/date.util';
import { DashboardService, periodBounds } from '../dashboard/dashboard.service';
import { CardPaymentsService } from '../credit-cards/card-payments.service';
import { CreateCardPaymentDto } from '../credit-cards/dto/create-card-payment.dto';
import { SettlementsService } from '../transactions/settlements.service';
import { CreateSettlementDto } from '../transactions/dto/create-settlement.dto';
import { OpenItemsQueryDto } from './dto/open-items-query.dto';
import { SummaryQueryDto } from './dto/summary-query.dto';
import { fromBusinessSummary, fromPersonalSummary, WhatsappSummary } from './whatsapp-summary';

/** Até quantos dias à frente uma conta em aberto entra na busca de baixa. */
const OPEN_ITEMS_HORIZON_DAYS = 45;

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
}
