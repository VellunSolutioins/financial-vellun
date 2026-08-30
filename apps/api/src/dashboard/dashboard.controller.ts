import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';
import { DashboardService } from './dashboard.service';

@ApiCookieAuth()
@ApiTags('dashboard')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  @Get('summary')
  getSummary(
    @Req() req: Request,
    @Query('period_start') periodStart?: string,
    @Query('period_end') periodEnd?: string,
  ) {
    const user = req.user as any;
    return this.dashboardService.getSummary(user.dataOwnerId, periodStart, periodEnd);
  }

  @Get('daily')
  getDaily(@Req() req: Request, @Query('month') month?: string) {
    const user = req.user as any;
    return this.dashboardService.getDailyBreakdown(user.dataOwnerId, month);
  }

  @Get('business/summary')
  getBusinessSummary(
    @Req() req: Request,
    @Query('period_start') periodStart?: string,
    @Query('period_end') periodEnd?: string,
  ) {
    const user = req.user as any;
    return this.dashboardService.getBusinessSummary(user.dataOwnerId, periodStart, periodEnd);
  }
}
