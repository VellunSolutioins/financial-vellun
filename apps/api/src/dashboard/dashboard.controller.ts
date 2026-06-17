import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DashboardService } from './dashboard.service';

@ApiCookieAuth()
@ApiTags('dashboard')
@UseGuards(JwtAuthGuard)
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
    return this.dashboardService.getSummary(user.id, periodStart, periodEnd);
  }
}
