import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';

import { SavingsBoxesService } from './savings-boxes.service';
import { CreateSavingsBoxDto } from './dto/create-savings-box.dto';
import { UpdateSavingsBoxDto } from './dto/update-savings-box.dto';
import { CreateContributionDto } from './dto/create-contribution.dto';

@ApiCookieAuth()
@ApiTags('savings-boxes')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('savings-boxes')
export class SavingsBoxesController {
  constructor(private savingsBoxesService: SavingsBoxesService) {}

  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as any;
    return this.savingsBoxesService.findAll(user.id);
  }

  @Get('summary')
  summary(@Req() req: Request) {
    const user = req.user as any;
    return this.savingsBoxesService.summary(user.id);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateSavingsBoxDto) {
    const user = req.user as any;
    return this.savingsBoxesService.create(user.id, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateSavingsBoxDto) {
    const user = req.user as any;
    return this.savingsBoxesService.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.savingsBoxesService.remove(user.id, id);
  }

  @Post(':id/contributions')
  addContribution(@Req() req: Request, @Param('id') id: string, @Body() dto: CreateContributionDto) {
    const user = req.user as any;
    return this.savingsBoxesService.addContribution(user.id, id, dto);
  }

  /** Gatilho manual (catch-up/testes) — aplica rendimento só das caixinhas do usuário logado. */
  @Post('apply-yield')
  applyYield(@Req() req: Request) {
    const user = req.user as any;
    return this.savingsBoxesService.applyYield(user.id);
  }
}
