import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { RequireFeature } from '../../feature-flags/decorators/require-feature.decorator';
import { FeatureEnabledGuard } from '../../feature-flags/guards/feature-enabled.guard';
import { InternalApiKeyGuard } from '../guards/internal-api-key.guard';
import { InternalActionsService } from '../internal-actions.service';
import { SummaryQueryDto } from '../dto/summary-query.dto';
import { OpenItemsQueryDto } from '../dto/open-items-query.dto';
import { UpdateEntryDto } from '../dto/update-entry.dto';
import { CreateSettlementDto } from '../../transactions/dto/create-settlement.dto';
import { CreateCardPaymentDto } from '../../credit-cards/dto/create-card-payment.dto';

/**
 * Ações do agente de WhatsApp (docs/plans/018). Cada grupo de rotas fica
 * atrás de uma feature flag: desligada, a rota responde `403 FEATURE_DISABLED`
 * e o agente manda o usuário para o app.
 */
@SkipThrottle()
@ApiExcludeController()
@UseGuards(InternalApiKeyGuard, FeatureEnabledGuard)
@Controller('internal/users/:userId')
export class InternalActionsController {
  constructor(private actions: InternalActionsService) {}

  @RequireFeature('whatsapp_summary')
  @Get('summary')
  summary(@Param('userId') userId: string, @Query() query: SummaryQueryDto) {
    return this.actions.summary(userId, query);
  }

  @RequireFeature('whatsapp_payments')
  @Get('open-items')
  openItems(@Param('userId') userId: string, @Query() query: OpenItemsQueryDto) {
    return this.actions.openItems(userId, query);
  }

  @RequireFeature('whatsapp_payments')
  @Post('transactions/:transactionId/settlements')
  settle(
    @Param('userId') userId: string,
    @Param('transactionId') transactionId: string,
    @Body() dto: CreateSettlementDto,
  ) {
    return this.actions.settle(userId, transactionId, dto);
  }

  @RequireFeature('whatsapp_payments')
  @Post('cards/:cardId/invoices/:invoiceId/payments')
  payInvoice(
    @Param('userId') userId: string,
    @Param('cardId') cardId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: CreateCardPaymentDto,
  ) {
    return this.actions.payInvoice(userId, cardId, invoiceId, dto);
  }

  @RequireFeature('whatsapp_edit')
  @Get('recent-entries')
  recentEntries(@Param('userId') userId: string) {
    return this.actions.recentEntries(userId);
  }

  @RequireFeature('whatsapp_edit')
  @Patch('transactions/:transactionId')
  updateEntry(
    @Param('userId') userId: string,
    @Param('transactionId') transactionId: string,
    @Body() dto: UpdateEntryDto,
  ) {
    return this.actions.updateEntry(userId, transactionId, dto);
  }

  @RequireFeature('whatsapp_edit')
  @Delete('transactions/:transactionId')
  removeEntry(@Param('userId') userId: string, @Param('transactionId') transactionId: string) {
    return this.actions.removeEntry(userId, transactionId);
  }

  @RequireFeature('whatsapp_edit')
  @Delete('installments/:seriesId')
  removeInstallments(@Param('userId') userId: string, @Param('seriesId') seriesId: string) {
    return this.actions.removeInstallments(userId, seriesId);
  }
}
