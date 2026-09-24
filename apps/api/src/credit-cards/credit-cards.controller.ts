import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';

import { CreditCardsService } from './credit-cards.service';
import { CreateCreditCardDto } from './dto/create-credit-card.dto';
import { ListCreditCardsDto } from './dto/list-credit-cards.dto';
import { SetupCreditCardDto } from './dto/setup-credit-card.dto';
import { UpdateCreditCardDto } from './dto/update-credit-card.dto';

@ApiCookieAuth()
@ApiTags('credit-cards')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('credit-cards')
export class CreditCardsController {
  constructor(private creditCardsService: CreditCardsService) {}

  @Get()
  findAll(@Req() req: Request, @Query() query: ListCreditCardsDto) {
    const user = req.user as any;
    return this.creditCardsService.findAll(user.id, query.includeArchived ?? false);
  }

  @Get('summary')
  summary(@Req() req: Request) {
    const user = req.user as any;
    return this.creditCardsService.summary(user.id);
  }

  @Get(':id')
  findOne(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.creditCardsService.findOne(user.id, id);
  }

  @Get(':id/invoices')
  invoices(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.creditCardsService.invoices(user.id, id);
  }

  @Get(':id/invoices/:invoiceId')
  invoice(@Req() req: Request, @Param('id') id: string, @Param('invoiceId') invoiceId: string) {
    const user = req.user as any;
    return this.creditCardsService.invoice(user.id, id, invoiceId);
  }

  /** Configura fechamento, vencimento e início do controle de um cartão pendente. */
  @Post(':id/setup')
  setup(@Req() req: Request, @Param('id') id: string, @Body() dto: SetupCreditCardDto) {
    const user = req.user as any;
    return this.creditCardsService.setup(user.id, id, dto);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateCreditCardDto) {
    const user = req.user as any;
    return this.creditCardsService.create(user.id, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateCreditCardDto) {
    const user = req.user as any;
    return this.creditCardsService.update(user.id, id, dto);
  }

  @Patch(':id/primary')
  setPrimary(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.creditCardsService.setPrimary(user.id, id);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.creditCardsService.remove(user.id, id);
  }
}
