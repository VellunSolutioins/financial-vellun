import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

import {
  OPS_SESSION_ABSOLUTE_TTL_SECONDS,
  OPS_SESSION_COOKIE,
  OPS_SESSION_RENEW_THRESHOLD_SECONDS,
} from '../../ops.constants';
import { CurrentOpsOperator } from '../decorators/current-operator.decorator';
import { GithubOAuthClient } from '../github-oauth.client';
import { OpsAuthService } from '../ops-auth.service';
import { OpsSessionService } from '../ops-session.service';

/**
 * Exige sessão de operador válida e popula `req.opsOperator`.
 *
 * Duas escolhas que valem explicitar:
 *
 * 1. **Sempre `403`, nunca `401`.** Um usuário do produto batendo em `/ops/*`
 *    não deve receber um convite a autenticar, e "sessão inválida" e "não é
 *    operador" não devem ser distinguíveis de fora. O `code` na resposta é o que
 *    permite ao painel decidir entre redirecionar ao login e mostrar o erro.
 * 2. **O papel vem do banco, não do token.** O token só carrega o `sub`
 *    confiável; papel e `canViewSensitive` são relidos a cada requisição, então
 *    revogar permissão tem efeito imediato em vez de esperar os 30 minutos.
 * 3. **A sessão tem prazo absoluto** (12 h desde o login) e, a cada renovação,
 *    o pertencimento à organização no GitHub é conferido de novo quando há
 *    `OPS_GITHUB_ORG_TOKEN`. Antes, quem saía da organização sem ser
 *    desativado aqui mantinha a sessão renovável indefinidamente.
 */
@Injectable()
export class OpsAuthGuard implements CanActivate {
  private readonly logger = new Logger(OpsAuthGuard.name);

  constructor(
    private readonly session: OpsSessionService,
    private readonly auth: OpsAuthService,
    private readonly github: GithubOAuthClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const token = (request.cookies as Record<string, string | undefined> | undefined)?.[
      OPS_SESSION_COOKIE
    ];
    if (!token) throw this.deny('OPS_SESSION_REQUIRED');

    const payload = await this.session.verify(token);
    if (!payload) throw this.deny('OPS_SESSION_REQUIRED');

    // Sessão sem momento de login (emitida antes do prazo absoluto) ou vencida.
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof payload.auth !== 'number' ||
      now - payload.auth >= OPS_SESSION_ABSOLUTE_TTL_SECONDS
    ) {
      this.session.clearSessionCookie(response);
      throw this.deny('OPS_SESSION_REQUIRED');
    }

    const operator = await this.auth.findById(payload.sub);
    if (!operator || !operator.active) {
      // Sessão emitida antes de o operador ser desativado: derruba na hora.
      this.session.clearSessionCookie(response);
      throw this.deny('OPS_SESSION_REQUIRED');
    }

    request.opsOperator = {
      id: operator.id,
      githubLogin: operator.githubLogin,
      role: operator.role,
      canViewSensitive: operator.canViewSensitive,
    };

    await this.renewIfNearExpiry(response, payload, operator);
    return true;
  }

  /**
   * Renovação deslizante: reemite o cookie quando falta menos que o limiar.
   *
   * Sem isso, o TTL curto derrubaria o operador no meio de uma investigação —
   * e a resposta natural seria aumentar o TTL, que é justamente o que não
   * queremos. Reemitir a cada requisição seria desperdício de assinatura.
   */
  private async renewIfNearExpiry(
    response: Response,
    payload: { exp: number; auth: number },
    operator: CurrentOpsOperator,
  ): Promise<void> {
    const secondsLeft = payload.exp - Math.floor(Date.now() / 1000);
    if (secondsLeft > OPS_SESSION_RENEW_THRESHOLD_SECONDS) return;

    // Renovar é o momento de reconfirmar a organização: acontece no máximo a
    // cada ~15 minutos por operador, e não custa uma chamada por requisição.
    // Sem resposta do GitHub (ou sem token configurado), a sessão segue até o
    // prazo absoluto; só um "não é membro" explícito a derruba.
    const member = await this.github.isOrgMemberByLogin(operator.githubLogin);
    if (member === false) {
      this.logger.warn(`Operador ${operator.githubLogin} não pertence mais à organização`);
      this.session.clearSessionCookie(response);
      throw this.deny('OPS_SESSION_REQUIRED');
    }

    await this.session.issueSessionCookie(response, {
      sub: operator.id,
      login: operator.githubLogin,
      role: operator.role,
      cvs: operator.canViewSensitive,
      auth: payload.auth,
    });
  }

  private deny(code: 'OPS_SESSION_REQUIRED'): ForbiddenException {
    return new ForbiddenException({
      statusCode: 403,
      code,
      message: 'Acesso restrito à área de operações.',
    });
  }
}
