import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';

import { RecurringRulesService } from './recurring-rules.service';
import { CreateRecurringRuleDto } from './dto/create-recurring-rule.dto';
import { UpdateRecurringRuleDto } from './dto/update-recurring-rule.dto';

@ApiCookieAuth()
@ApiTags('recurring-rules')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('recurring-rules')
export class RecurringRulesController {
  constructor(private recurringRulesService: RecurringRulesService) {}

  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as any;
    return this.recurringRulesService.findAll(user.id);
  }

  @Get('summary')
  summary(@Req() req: Request) {
    const user = req.user as any;
    return this.recurringRulesService.summary(user.id);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateRecurringRuleDto) {
    const user = req.user as any;
    return this.recurringRulesService.create(user.id, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateRecurringRuleDto) {
    const user = req.user as any;
    return this.recurringRulesService.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.recurringRulesService.remove(user.id, id);
  }

  /** Gatilho manual (catch-up/testes) — gera só as regras do usuário logado. */
  @Post('generate')
  generate(@Req() req: Request) {
    const user = req.user as any;
    return this.recurringRulesService.generateDue(user.id);
  }
}
