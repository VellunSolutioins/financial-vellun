import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InternalApiKeyGuard } from '../guards/internal-api-key.guard';
import { InternalService } from '../internal.service';
import { CreateAiTransactionDto } from '../dto/create-ai-transaction.dto';
import { AiEventDto } from '../dto/ai-event.dto';

@ApiExcludeController()
@UseGuards(InternalApiKeyGuard)
@Controller('internal')
export class InternalController {
  constructor(private internalService: InternalService) {}

  @Get('whatsapp/contacts/:phone')
  findContact(@Param('phone') phone: string) {
    return this.internalService.findContactByPhone(phone);
  }

  @Get('users/:userId/categories')
  listCategories(@Param('userId') userId: string) {
    return this.internalService.listCategories(userId);
  }

  @Get('users/:userId/accounts')
  listAccounts(@Param('userId') userId: string) {
    return this.internalService.listAccounts(userId);
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
