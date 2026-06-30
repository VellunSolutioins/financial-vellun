import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BillingService } from './billing.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

/**
 * Endpoints de billing. Permanecem acessíveis **sem** assinatura ativa (doc
 * seção 5) — só exigem identidade (JwtAuthGuard).
 */
@ApiCookieAuth()
@ApiTags('billing')
@UseGuards(JwtAuthGuard)
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('plans')
  listPlans() {
    return this.billingService.listPlans();
  }

  @Get('subscription')
  getSubscription(@Req() req: Request) {
    const user = req.user as any;
    return this.billingService.getSubscriptionState(user.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('checkout')
  createCheckout(@Req() req: Request, @Body() dto: CreateCheckoutDto) {
    const user = req.user as any;
    return this.billingService.createCheckout(user.id, dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('payment-method')
  createPaymentMethodSession(@Req() req: Request) {
    const user = req.user as any;
    return this.billingService.createPaymentMethodSession(user.id);
  }

  @Post('cancel')
  cancel(@Req() req: Request) {
    const user = req.user as any;
    return this.billingService.cancel(user.id);
  }
}
