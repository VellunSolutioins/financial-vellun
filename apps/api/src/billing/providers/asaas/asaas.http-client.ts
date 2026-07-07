import { Logger } from '@nestjs/common';

export interface AsaasHttpClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface AsaasRequestOptions {
  /** Permite retry com backoff. Use somente em operações idempotentes (GET). */
  idempotent?: boolean;
  query?: Record<string, string | number | undefined>;
}

/** Erro do Asaas sem nenhum segredo no payload (seguro para log). */
export class AsaasApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body?: unknown,
  ) {
    super(`Asaas ${method} ${path} falhou (HTTP ${status})`);
    this.name = 'AsaasApiError';
  }
}

/**
 * Cliente HTTP fino sobre o `fetch` nativo. Adiciona autenticação, timeout e
 * retry com backoff para chamadas idempotentes. **Nunca loga a `access_token`
 * nem corpos de requisição** (que podem conter dados pessoais).
 */
export class AsaasHttpClient {
  private readonly logger = new Logger(AsaasHttpClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: AsaasHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  get<T>(path: string, options: AsaasRequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, undefined, { idempotent: true, ...options });
  }

  post<T>(path: string, body: unknown, options: AsaasRequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  delete<T>(path: string, options: AsaasRequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    options: AsaasRequestOptions,
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const attempts = options.idempotent ? this.maxRetries + 1 : 1;

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.execute<T>(method, url, path, body);
      } catch (error) {
        lastError = error;
        // Não retenta erros de cliente (4xx) — só rede/timeout/5xx idempotentes.
        if (error instanceof AsaasApiError && error.status < 500) {
          throw error;
        }
        if (attempt < attempts - 1) {
          await this.delay(2 ** attempt * 250);
          this.logger.warn(`Asaas ${method} ${path}: tentativa ${attempt + 1} falhou, retentando`);
        }
      }
    }
    throw lastError;
  }

  private async execute<T>(method: string, url: string, path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          access_token: this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const payload = await this.parseBody(response);
      if (!response.ok) {
        throw new AsaasApiError(response.status, method, path, payload);
      }
      return payload as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
