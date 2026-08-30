import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';

import { RemindersService } from './reminders.service';
import { CreateReminderDto } from './dto/create-reminder.dto';
import { UpdateReminderDto } from './dto/update-reminder.dto';

@ApiCookieAuth()
@ApiTags('reminders')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('reminders')
export class RemindersController {
  constructor(private remindersService: RemindersService) {}

  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as any;
    return this.remindersService.findAll(user.id);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateReminderDto) {
    const user = req.user as any;
    return this.remindersService.create(user.id, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateReminderDto) {
    const user = req.user as any;
    return this.remindersService.update(user.id, id, dto);
  }

  @Post(':id/pay')
  pay(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.remindersService.pay(user.id, id);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.remindersService.remove(user.id, id);
  }
}
