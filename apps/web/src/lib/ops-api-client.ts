/**
 * Cliente HTTP da área de operações.
 *
 * Separado de `api-client.ts` de propósito, não por duplicação. O cliente do
 * produto tem dois comportamentos globais que a área de operações **não pode
 * herdar**:
 *
 * - em `403 SUBSCRIPTION_REQUIRED` ele redireciona para `/app/conta/assinatura`
 *   — operador não tem assinatura, e o redirecionamento sequestraria a tela;
 * - em `401` ele tenta `POST /auth/refresh`, que renovaria a sessão do **cliente**
 *   a partir de uma tela de operações.
 *
 * A sessão de ops é renovada pelo próprio servidor (cookie deslizante a cada
 * requisição autenticada), então aqui não existe fluxo de refresh.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const CSRF_COOKIE = 'csrf_token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Rota do painel para onde mandar quem perdeu (ou nunca teve) a sessão. */
export const OPS_LOGIN_PATH = '/ops/login';

export class OpsApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'OpsApiError';
  }

  /** A sessão acabou ou nunca existiu — o painel deve voltar ao login. */
  get isSessionMissing(): boolean {
    return this.statusCode === 403 && this.code === 'OPS_SESSION_REQUIRED';
  }

  /** A sessão vale, mas o papel não permite a ação. */
  get isRoleForbidden(): boolean {
    return this.statusCode === 403 && this.code === 'OPS_ROLE_REQUIRED';
  }
}

function readCsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`))
    ?.split('=')[1];
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase();
  const csrfToken = SAFE_METHODS.has(method) ? undefined : readCsrfToken();

  const response = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...options?.headers,
    },
  });

  if (!response.ok) {
    throw await toError(response);
  }

  // 204 e afins: não há corpo para desserializar.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function toError(response: Response): Promise<OpsApiError> {
  try {
    const body = (await response.json()) as { message?: string; code?: string };
    return new OpsApiError(response.status, body.message ?? 'Falha na requisição.', body.code);
  } catch {
    // Resposta sem JSON (proxy, timeout de gateway): não há código a extrair.
    return new OpsApiError(response.status, `Falha na requisição (HTTP ${response.status}).`);
  }
}

export const opsApiClient = {
  get: <T>(path: string, init?: RequestInit) => request<T>(path, { ...init, method: 'GET' }),
  post: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, {
      ...init,
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(path: string, body: unknown, init?: RequestInit) =>
    request<T>(path, { ...init, method: 'PATCH', body: JSON.stringify(body) }),
};

/** URL de início do OAuth. É navegação de página, não `fetch`. */
export function opsGithubLoginUrl(): string {
  return `${API_URL}/ops/auth/github`;
}

export type OpsRole = 'viewer' | 'operator' | 'ops_admin';

export interface OpsOperatorSession {
  id: string;
  githubLogin: string;
  role: OpsRole;
  canViewSensitive: boolean;
}
