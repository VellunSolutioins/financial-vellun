import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/session.service';
import { UnlinkPhoneDto } from './dto/unlink-phone.dto';
import { WhatsappLinkService } from './whatsapp-link.service';

@ApiCookieAuth()
@ApiTags('users')
@UseGuards(JwtAuthGuard)
@Controller('users/me/phone')
export class PhoneLinkController {
  constructor(private readonly whatsappLink: WhatsappLinkService) {}

  /** Desfaz o vínculo do WhatsApp. Pede a senha atual. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('unlink')
  unlink(@Req() req: Request, @Body() dto: UnlinkPhoneDto) {
    const user = req.user as AuthenticatedUser;
    return this.whatsappLink.unlink(user.id, dto.currentPassword, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}
