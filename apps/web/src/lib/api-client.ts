import type { ApiError, PaginatedResponse } from '@financial-vellun/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// Endpoints de autenticação não devem disparar refresh-em-401:
// - login/register: 401 = credenciais inválidas (deve aparecer ao usuário);
// - refresh/logout: 401 = sessão realmente encerrada.
const NO_REFRESH_PATHS = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];

export class ApiClientError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly error: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

// Dedup: um único refresh em voo é compartilhado por requests concorrentes.
let refreshPromise: Promise<boolean> | null = null;

function tryRefresh(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    })
      .then((r) => r.ok)
      .catch(() => false);
    void refreshPromise.finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function request<T>(path: string, options?: RequestInit, retry = true): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  // Access token expirado: tenta renovar via refresh_token e refaz a chamada uma vez.
  if (res.status === 401 && retry && !NO_REFRESH_PATHS.some((p) => path.startsWith(p))) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return request<T>(path, options, false);
    }
  }

  if (!res.ok) {
    const err = (await res.json()) as ApiError;
    throw new ApiClientError(err.statusCode, err.message, err.error);
  }

  return res.json() as Promise<T>;
}

export const apiClient = {
  get: <T>(path: string, init?: RequestInit) => request<T>(path, { ...init, method: 'GET' }),
  post: <T>(path: string, body: unknown, init?: RequestInit) =>
    request<T>(path, { ...init, method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown, init?: RequestInit) =>
    request<T>(path, { ...init, method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string, init?: RequestInit) => request<T>(path, { ...init, method: 'DELETE' }),
};

export type { PaginatedResponse, ApiError };
