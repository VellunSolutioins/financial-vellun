import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';
import { DashboardService } from './dashboard.service';
import { DashboardQueryDto } from './dashboard-query.dto';

@ApiCookieAuth()
@ApiTags('dashboard')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  @Get('summary')
  getSummary(@Req() req: Request, @Query() query: DashboardQueryDto) {
    const user = req.user as any;
    return this.dashboardService.getSummary(user.id, query.period_start, query.period_end, query);
  }

  /** Gráfico "Saiu da conta": despesas em conta e faturas pagas, por categoria. */
  @Get('accounts-spending')
  getAccountsSpending(@Req() req: Request, @Query() query: DashboardQueryDto) {
    const user = req.user as any;
    return this.dashboardService.getAccountsSpending(
      user.id,
      query.period_start,
      query.period_end,
      query,
    );
  }

  /** Gráfico "Foi no cartão": compras do período ainda não pagas, por categoria. */
  @Get('cards-unpaid')
  getCardsUnpaid(@Req() req: Request, @Query() query: DashboardQueryDto) {
    const user = req.user as any;
    return this.dashboardService.getCardsUnpaid(
      user.id,
      query.period_start,
      query.period_end,
      query,
    );
  }

  @Get('daily')
  getDaily(@Req() req: Request, @Query() query: DashboardQueryDto) {
    const user = req.user as any;
    return this.dashboardService.getDailyBreakdown(user.id, query.month, query);
  }

  @Get('business/summary')
  getBusinessSummary(@Req() req: Request, @Query() query: DashboardQueryDto) {
    const user = req.user as any;
    return this.dashboardService.getBusinessSummary(
      user.id,
      query.period_start,
      query.period_end,
      query,
    );
  }
}
