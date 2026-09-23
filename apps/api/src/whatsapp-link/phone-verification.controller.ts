import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/session.service';
import { StartPhoneVerificationDto } from './dto/start-verification.dto';
import { WhatsappLinkService } from './whatsapp-link.service';

@ApiCookieAuth()
@ApiTags('users')
@UseGuards(JwtAuthGuard)
@Controller('users/me/phone/verification')
export class PhoneVerificationController {
  constructor(private readonly whatsappLink: WhatsappLinkService) {}

  /** Gera (ou regenera) o código que o usuário envia ao bot. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  start(@Req() req: Request, @Body() dto: StartPhoneVerificationDto) {
    const user = req.user as AuthenticatedUser;
    return this.whatsappLink.startVerification(user.id, dto);
  }

  /** Estado do desafio; a tela consulta até ver `verified`. */
  @Get()
  status(@Req() req: Request) {
    const user = req.user as AuthenticatedUser;
    return this.whatsappLink.getState(user.id);
  }
}
