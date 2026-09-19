import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';

import { CreditCardsService } from './credit-cards.service';
import { CreateCreditCardDto } from './dto/create-credit-card.dto';
import { UpdateCreditCardDto } from './dto/update-credit-card.dto';

@ApiCookieAuth()
@ApiTags('credit-cards')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('credit-cards')
export class CreditCardsController {
  constructor(private creditCardsService: CreditCardsService) {}

  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as any;
    return this.creditCardsService.findAll(user.dataOwnerId);
  }

  @Get('summary')
  summary(@Req() req: Request) {
    const user = req.user as any;
    return this.creditCardsService.summary(user.dataOwnerId);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateCreditCardDto) {
    const user = req.user as any;
    return this.creditCardsService.create(user.dataOwnerId, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateCreditCardDto) {
    const user = req.user as any;
    return this.creditCardsService.update(user.dataOwnerId, id, dto);
  }

  @Patch(':id/primary')
  setPrimary(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.creditCardsService.setPrimary(user.dataOwnerId, id);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.creditCardsService.remove(user.dataOwnerId, id);
  }
}
