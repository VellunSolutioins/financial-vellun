import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';

import { FinancialResourcesService } from './financial-resources.service';

@ApiCookieAuth()
@ApiTags('financial-resources')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('financial-resources')
export class FinancialResourcesController {
  constructor(private financialResourcesService: FinancialResourcesService) {}

  /** `{ accounts, cards }` para os seletores de conta/cartão. */
  @Get()
  list(@Req() req: Request) {
    const user = req.user as any;
    return this.financialResourcesService.list(user.id);
  }
}
