import { Body, Controller, Delete, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';
import { InstallmentsService } from './installments.service';
import { DeleteInstallmentQueryDto, UpdateInstallmentDto } from './dto/update-installment.dto';

/**
 * Visão por compra dos lançamentos parcelados. Criar um parcelamento é criar
 * um lançamento parcelado (`POST /transactions`); não existe registro próprio.
 */
@ApiCookieAuth()
@ApiTags('installments')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('installments')
export class InstallmentsController {
  constructor(private installmentsService: InstallmentsService) {}

  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as any;
    return this.installmentsService.findAll(user.id);
  }

  @Get(':seriesId')
  findOne(@Req() req: Request, @Param('seriesId') seriesId: string) {
    const user = req.user as any;
    return this.installmentsService.findOne(user.id, seriesId);
  }

  @Patch(':seriesId')
  update(
    @Req() req: Request,
    @Param('seriesId') seriesId: string,
    @Body() dto: UpdateInstallmentDto,
  ) {
    const user = req.user as any;
    return this.installmentsService.update(user.id, seriesId, dto);
  }

  @Delete(':seriesId')
  remove(
    @Req() req: Request,
    @Param('seriesId') seriesId: string,
    @Query() query: DeleteInstallmentQueryDto,
  ) {
    const user = req.user as any;
    return this.installmentsService.remove(user.id, seriesId, query.scope ?? 'all');
  }
}
