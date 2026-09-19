import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalApiKeyGuard } from '../guards/internal-api-key.guard';
import { InternalService } from '../internal.service';
import { CreateAiTransactionDto } from '../dto/create-ai-transaction.dto';
import { AiEventDto } from '../dto/ai-event.dto';
import { ListMessagesQueryDto } from '../dto/list-messages.dto';
import { CreateRecurringRuleFromAiDto } from '../dto/create-recurring-rule-from-ai.dto';
import { CreateSpendingGoalFromAiDto } from '../dto/create-spending-goal-from-ai.dto';
import { CreateSavingsBoxFromAiDto } from '../dto/create-savings-box-from-ai.dto';
import { CreateSavingsContributionFromAiDto } from '../dto/create-savings-contribution-from-ai.dto';
import { CreateCreditCardFromAiDto } from '../dto/create-credit-card-from-ai.dto';
import { CreateReminderFromAiDto } from '../dto/create-reminder-from-ai.dto';
import { CreateAgendaEventFromAiDto } from '../dto/create-agenda-event-from-ai.dto';
import { CreateNoteFromAiDto } from '../dto/create-note-from-ai.dto';

@SkipThrottle()
@ApiExcludeController()
@UseGuards(InternalApiKeyGuard)
@Controller('internal')
export class InternalController {
  constructor(private internalService: InternalService) {}

  @Get('whatsapp/contacts/:phone')
  findContact(@Param('phone') phone: string) {
    return this.internalService.findContactByPhone(phone);
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

  @Post('recurring-rules/from-ai')
  createRecurringRule(@Body() dto: CreateRecurringRuleFromAiDto) {
    return this.internalService.createRecurringRuleFromAi(dto);
  }

  @Post('spending-goals/from-ai')
  createSpendingGoal(@Body() dto: CreateSpendingGoalFromAiDto) {
    return this.internalService.createSpendingGoalFromAi(dto);
  }

  @Post('savings-boxes/from-ai')
  createSavingsBox(@Body() dto: CreateSavingsBoxFromAiDto) {
    return this.internalService.createSavingsBoxFromAi(dto);
  }

  @Post('savings-boxes/contributions/from-ai')
  createSavingsContribution(@Body() dto: CreateSavingsContributionFromAiDto) {
    return this.internalService.createSavingsContributionFromAi(dto);
  }

  @Post('credit-cards/from-ai')
  createCreditCard(@Body() dto: CreateCreditCardFromAiDto) {
    return this.internalService.createCreditCardFromAi(dto);
  }

  @Post('reminders/from-ai')
  createReminder(@Body() dto: CreateReminderFromAiDto) {
    return this.internalService.createReminderFromAi(dto);
  }

  @Post('agenda-events/from-ai')
  createAgendaEvent(@Body() dto: CreateAgendaEventFromAiDto) {
    return this.internalService.createAgendaEventFromAi(dto);
  }

  @Post('notes/from-ai')
  createNote(@Body() dto: CreateNoteFromAiDto) {
    return this.internalService.createNoteFromAi(dto);
  }
}
