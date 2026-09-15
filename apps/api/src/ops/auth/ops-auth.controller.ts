import { Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';

import { OPS_OAUTH_STATE_COOKIE } from '../ops.constants';
import { CurrentOperator, CurrentOpsOperator } from './decorators/current-operator.decorator';
import { OpsAuthGuard } from './guards/ops-auth.guard';
import { GithubOAuthClient, GithubOAuthError } from './github-oauth.client';
import { OpsAuthService, OpsLoginRejection } from './ops-auth.service';
import { OpsSessionService } from './ops-session.service';

/**
 * Fluxo OAuth do GitHub para operadores.
 *
 * Fica fora do Swagger: a documentação pública da API não é lugar para a
 * superfície de operações.
 */
@ApiExcludeController()
@Controller('ops/auth')
export class OpsAuthController {
  constructor(
    private readonly auth: OpsAuthService,
    private readonly session: OpsSessionService,
    private readonly github: GithubOAuthClient,
    private readonly config: ConfigService,
  ) {}

  /** Início do login: guarda o `state` em cookie e manda para o GitHub. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('github')
  start(@Res() res: Response): void {
    const state = this.auth.newOauthState();
    this.session.setOauthStateCookie(res, state);
    res.redirect(this.github.authorizeUrl(state));
  }

  /**
   * Callback do GitHub.
   *
   * Sempre redireciona para o painel — nunca devolve JSON. O resultado viaja em
   * `?erro=` na URL de login, porque este endpoint é aberto no browser pelo
   * próprio GitHub, não por `fetch`.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('github/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const cookieState = (req.cookies as Record<string, string | undefined> | undefined)?.[
      OPS_OAUTH_STATE_COOKIE
    ];
    // O cookie é de uso único: consumido aqui, aconteça o que acontecer.
    this.session.clearOauthStateCookie(res);

    if (!this.auth.stateMatches(state, cookieState)) {
      res.redirect(this.loginUrl('state_invalido'));
      return;
    }
    if (!code) {
      res.redirect(this.loginUrl('code_ausente'));
      return;
    }

    try {
      const outcome = await this.auth.completeLogin(code);

      if (outcome.status === 'rejected') {
        res.redirect(this.loginUrl(this.rejectionCode(outcome.reason)));
        return;
      }

      await this.session.issueSessionCookie(res, {
        sub: outcome.operator.id,
        login: outcome.operator.githubLogin,
        role: outcome.operator.role,
        cvs: outcome.operator.canViewSensitive,
      });
      res.redirect(this.panelUrl());
    } catch (error) {
      if (error instanceof GithubOAuthError) {
        res.redirect(this.loginUrl('github_indisponivel'));
        return;
      }
      throw error;
    }
  }

  /** Quem está na sessão. É também o que renova o cookie ao abrir o painel. */
  @UseGuards(OpsAuthGuard)
  @Get('me')
  me(@CurrentOperator() operator: CurrentOpsOperator): CurrentOpsOperator {
    return operator;
  }

  @UseGuards(OpsAuthGuard)
  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response): { message: string } {
    this.session.clearSessionCookie(res);
    return { message: 'Sessão de operações encerrada.' };
  }

  private rejectionCode(reason: OpsLoginRejection): string {
    return reason === 'not_org_member' ? 'fora_da_organizacao' : 'aguardando_ativacao';
  }

  private webBaseUrl(): string {
    return (this.config.get<string>('WEB_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  private loginUrl(erro: string): string {
    return `${this.webBaseUrl()}/ops/login?erro=${encodeURIComponent(erro)}`;
  }

  private panelUrl(): string {
    return `${this.webBaseUrl()}/ops`;
  }
}
