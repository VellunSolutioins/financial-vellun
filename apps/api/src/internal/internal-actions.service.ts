import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionAccessService } from '../billing/services/subscription-access.service';
import { SubscriptionRequiredException } from '../billing/subscription-required.exception';
import { dateOnlyString, todaySaoPaulo } from '../common/date.util';
import { DashboardService, periodBounds } from '../dashboard/dashboard.service';
import { SummaryQueryDto } from './dto/summary-query.dto';
import { fromBusinessSummary, fromPersonalSummary, WhatsappSummary } from './whatsapp-summary';

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
}
