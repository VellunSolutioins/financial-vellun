import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { ACCESS_COOKIE, AuthenticatedUser, SessionService } from '../session.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private sessions: SessionService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => req?.cookies?.[ACCESS_COOKIE] ?? null,
      ]),
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * A mesma consulta que antes carregava o usuário agora carrega a sessão com
   * o usuário: sessão revogada ou expirada derruba o acesso na hora, sem custo
   * extra por requisição.
   */
  validate(payload: { sub?: string; sid?: string; typ?: 'access' }): Promise<AuthenticatedUser> {
    return this.sessions.validateAccess(payload);
  }
}
