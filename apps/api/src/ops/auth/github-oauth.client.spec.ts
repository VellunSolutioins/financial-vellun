import { ConfigService } from '@nestjs/config';
import { GithubOAuthClient } from './github-oauth.client';

describe('GithubOAuthClient.authorizeUrl', () => {
  const valores: Record<string, string> = {
    OPS_GITHUB_CLIENT_ID: 'client-1',
    OPS_GITHUB_ORG: 'vellun',
    API_URL: 'http://localhost:3001/',
  };
  const config = {
    get: (chave: string) => valores[chave],
    getOrThrow: (chave: string) => valores[chave],
  } as unknown as ConfigService;

  const params = () => new URL(new GithubOAuthClient(config).authorizeUrl('state-1')).searchParams;

  it('força o seletor de contas', () => {
    // `allow_signup` só esconde o cadastro; quem troca de conta é o `prompt`.
    // Sem ele, um operador com duas contas no browser nunca consegue trocar.
    expect(params().get('prompt')).toBe('select_account');
  });

  it('esconde o cadastro de conta nova', () => {
    expect(params().get('allow_signup')).toBe('false');
  });

  it('carrega client, state e callback', () => {
    const p = params();
    expect(p.get('client_id')).toBe('client-1');
    expect(p.get('state')).toBe('state-1');
    expect(p.get('redirect_uri')).toBe('http://localhost:3001/ops/auth/github/callback');
  });
});
