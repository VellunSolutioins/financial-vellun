import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { issueCsrfCookie } from '../common/csrf.util';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthenticatedUser, REFRESH_COOKIE, SessionService } from './session.service';
import { SecurityEventsService } from '../security-events/security-events.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private sessions: SessionService,
    private securityEvents: SecurityEventsService,
  ) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, tokens } = await this.authService.login(dto, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    this.sessions.setAuthCookies(res, tokens);
    return user;
  }

  /** Revoga a sessão atual no servidor, além de apagar os cookies. */
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const sessionId = await this.sessions.sessionIdFromRequest(req);
    if (sessionId) await this.sessions.revokeSession(sessionId);
    this.sessions.clearAuthCookies(res);
    return { message: 'Logout realizado com sucesso' };
  }

  /** Encerra a sessão em todos os dispositivos, inclusive neste. */
  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard)
  @Post('logout-all')
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const user = req.user as AuthenticatedUser;
    const encerradas = await this.sessions.revokeAllForUser(user.id);
    await this.securityEvents.record(user.id, 'sessions_revoked', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { sessoesEncerradas: encerradas },
    });
    this.sessions.clearAuthCookies(res);
    return { message: 'Todas as sessões foram encerradas' };
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.sessions.refresh(req.cookies?.[REFRESH_COOKIE]);
    this.sessions.setAuthCookies(res, tokens);
    return { message: 'Token renovado' };
  }

  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Reemite o token CSRF para que sessões já existentes recebam o cookie.
    issueCsrfCookie(res, this.sessions.cookieOptions);
    const user = req.user as AuthenticatedUser;
    return this.authService.me(user.id);
  }
}
