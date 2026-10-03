import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';
import { SettlementsService } from './settlements.service';
import { CreateSettlementDto } from './dto/create-settlement.dto';

class ReviewPageDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

/** Pagamentos e recebimentos de um lançamento de conta comum (docs/adrs/0018). */
@ApiCookieAuth()
@ApiTags('transactions')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('transactions/:id/settlements')
export class SettlementsController {
  constructor(private settlementsService: SettlementsService) {}

  @Get()
  list(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.settlementsService.list(user.id, id);
  }

  /** Registra pagamento/recebimento (parcial ou total) ou dispensa do restante. Idempotente. */
  @Post()
  settle(@Req() req: Request, @Param('id') id: string, @Body() dto: CreateSettlementDto) {
    const user = req.user as any;
    return this.settlementsService.settle(user.id, id, dto);
  }

  /** Reverte uma liquidação: o valor volta a ficar em aberto e o saldo é recomposto. */
  @Post(':settlementId/reverse')
  reverse(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('settlementId') settlementId: string,
  ) {
    const user = req.user as any;
    return this.settlementsService.reverse(user.id, id, settlementId);
  }
}

/**
 * Conciliação dos pagamentos que a migração inferiu (`legacy_matured`): o
 * lançamento entrou no saldo só porque a data chegou. O usuário confirma que
 * pagou ou desfaz.
 */
@ApiCookieAuth()
@ApiTags('transactions')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('reconciliation/legacy-settlements')
export class ReconciliationController {
  constructor(private settlementsService: SettlementsService) {}

  @Get()
  list(@Req() req: Request, @Query() query: ReviewPageDto) {
    const user = req.user as any;
    return this.settlementsService.listForReview(user.id, query.page ?? 1);
  }

  @Post('confirm-all')
  confirmAll(@Req() req: Request) {
    const user = req.user as any;
    return this.settlementsService.confirmAllReviews(user.id);
  }

  @Post(':settlementId/confirm')
  confirm(@Req() req: Request, @Param('settlementId') settlementId: string) {
    const user = req.user as any;
    return this.settlementsService.confirmReview(user.id, settlementId);
  }

  @Post(':settlementId/undo')
  undo(@Req() req: Request, @Param('settlementId') settlementId: string) {
    const user = req.user as any;
    return this.settlementsService.undoReview(user.id, settlementId);
  }
}
