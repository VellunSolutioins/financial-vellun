import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';

import { AgendaEventsService } from './agenda-events.service';
import { CreateAgendaEventDto } from './dto/create-agenda-event.dto';
import { UpdateAgendaEventDto } from './dto/update-agenda-event.dto';

@ApiCookieAuth()
@ApiTags('agenda-events')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('agenda-events')
export class AgendaEventsController {
  constructor(private agendaEventsService: AgendaEventsService) {}

  @Get()
  findAll(@Req() req: Request, @Query('month') month?: string) {
    const user = req.user as any;
    return this.agendaEventsService.findAll(user.dataOwnerId, month);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateAgendaEventDto) {
    const user = req.user as any;
    return this.agendaEventsService.create(user.dataOwnerId, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateAgendaEventDto) {
    const user = req.user as any;
    return this.agendaEventsService.update(user.dataOwnerId, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.agendaEventsService.remove(user.dataOwnerId, id);
  }
}
