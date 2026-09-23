import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InternalApiKeyGuard } from '../guards/internal-api-key.guard';
import { InternalService } from '../internal.service';
import { CreateAiTransactionDto } from '../dto/create-ai-transaction.dto';
import { AiEventDto } from '../dto/ai-event.dto';
import { ListMessagesQueryDto } from '../dto/list-messages.dto';
import { ConfirmPhoneVerificationDto } from '../../whatsapp-link/dto/confirm-verification.dto';
import { WhatsappLinkService } from '../../whatsapp-link/whatsapp-link.service';

@SkipThrottle()
@ApiExcludeController()
@UseGuards(InternalApiKeyGuard)
@Controller('internal')
export class InternalController {
  constructor(
    private internalService: InternalService,
    private whatsappLink: WhatsappLinkService,
  ) {}

  @Get('whatsapp/contacts/:phone')
  findContact(@Param('phone') phone: string) {
    return this.internalService.findContactByPhone(phone);
  }

  /**
   * Código de verificação enviado ao bot. Sempre `200`: o `status` diz ao
   * agente qual resposta dar (`verified`, `invalid_code`, `expired` ou
   * `not_found` — este último quando não há desafio para o número).
   */
  @HttpCode(200)
  @Post('whatsapp/verify')
  confirmPhoneVerification(@Body() dto: ConfirmPhoneVerificationDto) {
    return this.whatsappLink.confirmFromWhatsapp(dto.phone, dto.code);
  }

  @Get('whatsapp/contacts/:phone/messages')
  listRecentMessages(@Param('phone') phone: string, @Query() query: ListMessagesQueryDto) {
    return this.internalService.listRecentMessagesByPhone(phone, query.limit);
  }

  @Get('users/:userId/categories')
  listCategories(@Param('userId') userId: string) {
    return this.internalService.listCategories(userId);
  }

  @Get('users/:userId/accounts')
  listAccounts(@Param('userId') userId: string) {
    return this.internalService.listAccounts(userId);
  }

  @Get('users/:userId/subscription-access')
  getSubscriptionAccess(@Param('userId') userId: string) {
    return this.internalService.getSubscriptionAccess(userId);
  }

  @Post('transactions/from-ai')
  createTransaction(@Body() dto: CreateAiTransactionDto) {
    return this.internalService.createTransactionFromAi(dto);
  }

  @Post('ai-events')
  recordEvent(@Body() dto: AiEventDto) {
    return this.internalService.recordEvent(dto);
  }
}
