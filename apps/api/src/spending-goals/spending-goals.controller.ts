import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';

import { SpendingGoalsService } from './spending-goals.service';
import { CreateSpendingGoalDto } from './dto/create-spending-goal.dto';
import { UpdateSpendingGoalDto } from './dto/update-spending-goal.dto';

@ApiCookieAuth()
@ApiTags('spending-goals')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('spending-goals')
export class SpendingGoalsController {
  constructor(private spendingGoalsService: SpendingGoalsService) {}

  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as any;
    return this.spendingGoalsService.findAll(user.id);
  }

  @Get('summary')
  summary(@Req() req: Request) {
    const user = req.user as any;
    return this.spendingGoalsService.summary(user.id);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateSpendingGoalDto) {
    const user = req.user as any;
    return this.spendingGoalsService.create(user.id, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateSpendingGoalDto) {
    const user = req.user as any;
    return this.spendingGoalsService.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.spendingGoalsService.remove(user.id, id);
  }
}
