import { Body, Controller, Delete, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { issueCsrfCookie } from '../common/csrf.util';

import { MembersService } from './members.service';
import { InviteMemberDto } from './dto/invite-member.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';

const isProduction = process.env.NODE_ENV === 'production';

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: isProduction ? ('none' as const) : ('lax' as const),
  secure: isProduction,
};

@ApiTags('members')
@Controller('members')
export class MembersController {
  constructor(
    private membersService: MembersService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard)
  @Get()
  list(@Req() req: Request) {
    const user = req.user as any;
    return this.membersService.listMembers(user.dataOwnerId);
  }

  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard)
  @Get('invites')
  listInvites(@Req() req: Request) {
    const user = req.user as any;
    const webUrl = this.config.get<string>('WEB_URL') ?? 'http://localhost:3000';
    return this.membersService.listInvites(user.id, webUrl);
  }

  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invite')
  invite(@Req() req: Request, @Body() dto: InviteMemberDto) {
    const user = req.user as any;
    const webUrl = this.config.get<string>('WEB_URL') ?? 'http://localhost:3000';
    return this.membersService.invite(user.id, dto.email, webUrl);
  }

  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard)
  @Delete('invites/:id')
  revokeInvite(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.membersService.revokeInvite(user.id, id);
  }

  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.membersService.removeMember(user.id, id);
  }

  /** Rota pública — a página de convite não tem sessão ainda. */
  @Get('invite/:token')
  getInvite(@Param('token') token: string) {
    return this.membersService.getInviteByToken(token);
  }

  /** Rota pública — cria o login do membro e já autentica (mesmo padrão do /auth/login). */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('accept-invite')
  async acceptInvite(@Body() dto: AcceptInviteDto, @Res({ passthrough: true }) res: Response) {
    const user = await this.membersService.acceptInvite(dto.token, dto.name, dto.password);

    const payload = { sub: user.id, email: user.email };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.config.get('JWT_SECRET'),
        expiresIn: '15m',
      }),
      this.jwtService.signAsync(payload, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      }),
    ]);

    res.cookie('access_token', accessToken, { ...COOKIE_OPTIONS, maxAge: 15 * 60 * 1000 });
    res.cookie('refresh_token', refreshToken, { ...COOKIE_OPTIONS, maxAge: 7 * 24 * 60 * 60 * 1000 });
    issueCsrfCookie(res, COOKIE_OPTIONS);

    const { passwordHash: _, ...result } = user;
    return result;
  }
}
