import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { GITHUB_OAUTH_SCOPE } from '../ops.constants';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_URL = 'https://api.github.com';
const TIMEOUT_MS = 10_000;

/** Identidade do usuário no GitHub, só o que a área de operações usa. */
export interface GithubIdentity {
  githubUserId: string;
  login: string;
  name: string | null;
  email: string | null;
}

/** Falha na conversa com o GitHub. Nunca carrega o token no `message`. */
export class GithubOAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GithubOAuthError';
  }
}

/**
 * Cliente do OAuth do GitHub para identificar operadores.
 *
 * Pedimos o escopo mínimo (`read:org`), suficiente para ler o *próprio*
 * pertencimento do usuário à organização — não damos acesso a repositório nem a
 * dado de terceiro.
 */
@Injectable()
export class GithubOAuthClient {
  private readonly logger = new Logger(GithubOAuthClient.name);

  constructor(private readonly config: ConfigService) {}

  get organization(): string {
    return this.config.getOrThrow<string>('OPS_GITHUB_ORG');
  }

  /** URL de autorização, com o `state` que o callback vai conferir. */
  authorizeUrl(state: string): string {
    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.getOrThrow<string>('OPS_GITHUB_CLIENT_ID'));
    url.searchParams.set('redirect_uri', this.callbackUrl());
    url.searchParams.set('scope', GITHUB_OAUTH_SCOPE);
    url.searchParams.set('state', state);
    // Força o seletor de contas: sem isso o GitHub reaproveita a sessão do
    // browser e um operador com duas contas nunca consegue trocar.
    url.searchParams.set('prompt', 'select_account');
    // Esconde o "criar conta" da tela de login: o painel só aceita membros da
    // organização, e uma conta nova nunca é.
    url.searchParams.set('allow_signup', 'false');
    return url.toString();
  }

  private callbackUrl(): string {
    const explicit = this.config.get<string>('OPS_GITHUB_CALLBACK_URL');
    if (explicit) return explicit;

    const apiUrl = this.config.get<string>('API_URL') ?? 'http://localhost:3001';
    return `${apiUrl.replace(/\/+$/, '')}/ops/auth/github/callback`;
  }

  /** Troca o `code` pelo token de acesso do usuário. */
  async exchangeCode(code: string): Promise<string> {
    const response = await this.fetchWithTimeout(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.getOrThrow<string>('OPS_GITHUB_CLIENT_ID'),
        client_secret: this.config.getOrThrow<string>('OPS_GITHUB_CLIENT_SECRET'),
        code,
        redirect_uri: this.callbackUrl(),
      }),
    });

    if (!response.ok) {
      throw new GithubOAuthError('Falha ao trocar o code do GitHub', response.status);
    }

    // O GitHub responde 200 mesmo em erro de negócio (`code` expirado, por
    // exemplo) — o erro vem no corpo.
    const body = (await response.json()) as { access_token?: string; error?: string };
    if (!body.access_token) {
      throw new GithubOAuthError(`GitHub recusou o code: ${body.error ?? 'sem access_token'}`);
    }
    return body.access_token;
  }

  async fetchIdentity(token: string): Promise<GithubIdentity> {
    const user = await this.apiGet<{
      id: number;
      login: string;
      name: string | null;
      email: string | null;
    }>('/user', token);

    return {
      githubUserId: String(user.id),
      login: user.login,
      name: user.name ?? null,
      email: user.email ?? null,
    };
  }

  /**
   * Pertencimento **ativo** à organização.
   *
   * Usa `/user/memberships/orgs/{org}` (o próprio usuário) em vez de
   * `/orgs/{org}/members/{login}`, que exigiria um token da organização com
   * escopo administrativo guardado na API. Um convite ainda não aceito vem como
   * `pending` e **não** conta: só `active` é pertencimento.
   */
  async isActiveOrgMember(token: string): Promise<boolean> {
    const org = this.organization;
    try {
      const membership = await this.apiGet<{ state: string }>(
        `/user/memberships/orgs/${encodeURIComponent(org)}`,
        token,
      );
      return membership.state === 'active';
    } catch (error) {
      // 403/404 é a resposta normal para quem não pertence — não é incidente.
      if (error instanceof GithubOAuthError && (error.status === 403 || error.status === 404)) {
        return false;
      }
      throw error;
    }
  }

  private async apiGet<T>(path: string, token: string): Promise<T> {
    const response = await this.fetchWithTimeout(`${GITHUB_API_URL}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'financial-vellun-ops',
      },
    });

    if (!response.ok) {
      throw new GithubOAuthError(`GitHub GET ${path} falhou`, response.status);
    }
    return (await response.json()) as T;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      this.logger.warn(`Falha de rede ao falar com o GitHub: ${(error as Error).name}`);
      throw new GithubOAuthError('GitHub inacessível');
    } finally {
      clearTimeout(timeout);
    }
  }
}
