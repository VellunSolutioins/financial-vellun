import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';

import { FinancialAnalysisService } from './financial-analysis.service';

@ApiCookieAuth()
@ApiTags('financial-analysis')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('financial-analysis')
export class FinancialAnalysisController {
  constructor(private financialAnalysisService: FinancialAnalysisService) {}

  @Get('scores')
  getScores(@Req() req: Request) {
    const user = req.user as any;
    return this.financialAnalysisService.getScores(user.dataOwnerId);
  }
}
