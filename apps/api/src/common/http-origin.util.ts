/**
 * Origens web aceitas pelo CORS e pelo guard CSRF.
 *
 * Em produção (`NODE_ENV=production`) a lista é **exata**: `WEB_URL`,
 * `WEB_ALLOWED_ORIGINS` e o domínio de produção do frontend. Localhost e os
 * previews de branch da Vercel só valem fora de produção — um preview roda
 * código de qualquer branch, e aceitá-lo contra a API de produção deixava esse
 * código fazer chamadas autenticadas com a sessão de quem o visitasse
 * (plano de segurança, S2). Um preview que precise da API de produção entra por
 * `WEB_ALLOWED_ORIGINS`, com a origem exata.
 *
 * Lido a cada chamada, e não no carregamento do módulo, para que o ambiente
 * efetivo (e os testes) decidam.
 */
const PRODUCTION_WEB_ORIGIN = 'https://financial-vellun-web.vercel.app';
const LOCAL_WEB_ORIGIN = 'http://localhost:3000';
const VERCEL_PREVIEW_ORIGIN =
  /^https:\/\/financial-vellun-web-git-[a-z0-9-]+-vellun-s-projects\.vercel\.app$/;

export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/$/, '');
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function exactOrigins(): string[] {
  const configured = [process.env.WEB_URL, ...(process.env.WEB_ALLOWED_ORIGINS?.split(',') ?? [])];
  const defaults = isProduction()
    ? [PRODUCTION_WEB_ORIGIN]
    : [PRODUCTION_WEB_ORIGIN, LOCAL_WEB_ORIGIN];
  return [...configured, ...defaults]
    .filter((origin): origin is string => Boolean(origin?.trim()))
    .map(normalizeOrigin);
}

export function isAllowedWebOrigin(origin?: string): boolean {
  if (!origin) return false;

  const normalized = normalizeOrigin(origin);
  if (exactOrigins().includes(normalized)) return true;
  return !isProduction() && VERCEL_PREVIEW_ORIGIN.test(normalized);
}
