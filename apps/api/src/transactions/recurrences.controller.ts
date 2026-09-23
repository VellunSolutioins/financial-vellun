import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';
import { RecurrencesService } from './recurrences.service';
import { UpdateRecurrenceDto } from './dto/update-recurrence.dto';

/**
 * Visão por série dos lançamentos fixos. Criar uma recorrência é criar um
 * lançamento fixo (`POST /transactions`); não existe registro próprio.
 */
@ApiCookieAuth()
@ApiTags('recurrences')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('recurrences')
export class RecurrencesController {
  constructor(private recurrencesService: RecurrencesService) {}

  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as any;
    return this.recurrencesService.findAll(user.id);
  }

  @Get('summary')
  summary(@Req() req: Request) {
    const user = req.user as any;
    return this.recurrencesService.summary(user.id);
  }

  @Patch(':seriesId')
  update(
    @Req() req: Request,
    @Param('seriesId') seriesId: string,
    @Body() dto: UpdateRecurrenceDto,
  ) {
    const user = req.user as any;
    return this.recurrencesService.update(user.id, seriesId, dto);
  }

  @Post(':seriesId/pause')
  pause(@Req() req: Request, @Param('seriesId') seriesId: string) {
    const user = req.user as any;
    return this.recurrencesService.setActive(user.id, seriesId, false);
  }

  @Post(':seriesId/resume')
  resume(@Req() req: Request, @Param('seriesId') seriesId: string) {
    const user = req.user as any;
    return this.recurrencesService.setActive(user.id, seriesId, true);
  }

  @Delete(':seriesId')
  remove(@Req() req: Request, @Param('seriesId') seriesId: string) {
    const user = req.user as any;
    return this.recurrencesService.remove(user.id, seriesId);
  }
}
