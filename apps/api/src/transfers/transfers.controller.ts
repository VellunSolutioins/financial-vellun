import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';
import { TransfersService } from './transfers.service';
import { CreateTransferDto, ListTransfersDto } from './dto/create-transfer.dto';

/**
 * Transferências entre contas próprias, aportes, resgates, empréstimos e
 * amortizações (docs/adrs/0018). Não são receita nem despesa.
 */
@ApiCookieAuth()
@ApiTags('transfers')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('transfers')
export class TransfersController {
  constructor(private transfersService: TransfersService) {}

  @Get()
  list(@Req() req: Request, @Query() query: ListTransfersDto) {
    const user = req.user as any;
    return this.transfersService.list(user.id, query.page ?? 1);
  }

  /** Cria a transferência (e a despesa de juros/tarifa, se houver). Idempotente. */
  @Post()
  create(@Req() req: Request, @Body() dto: CreateTransferDto) {
    const user = req.user as any;
    return this.transfersService.create(user.id, dto);
  }

  @Post(':id/reverse')
  reverse(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.transfersService.reverse(user.id, id);
  }
}
