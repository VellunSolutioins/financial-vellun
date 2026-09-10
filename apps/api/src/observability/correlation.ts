import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Header de correlação. O agente de IA já usa exatamente este nome. */
export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Limite do id aceito de fora. Um header sem limite viraria vetor de poluição de
 * log (e, se algum dia virasse label, de cardinalidade).
 */
const MAX_LENGTH = 128;

/** Só o que é seguro em log, URL e valor de header. */
const SAFE_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface CorrelationStore {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationStore>();

/**
 * Correlação da requisição em curso, ou `undefined` fora de uma.
 *
 * Fora de requisição (cron, bootstrap) é o caso normal, não erro — por isso
 * `undefined` em vez de exceção: um logger não pode quebrar o que está logando.
 */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Normaliza o id recebido: aceita o de fora quando é seguro, senão gera um.
 *
 * Aceitar o id do cliente é o que permite seguir um fluxo entre serviços; deixar
 * de validá-lo é o que permitiria injetar quebra de linha num log estruturado.
 */
export function sanitizeIncomingCorrelationId(value: unknown): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== 'string') return newCorrelationId();

  const trimmed = candidate.trim();
  if (!trimmed || trimmed.length > MAX_LENGTH || !SAFE_PATTERN.test(trimmed)) {
    return newCorrelationId();
  }
  return trimmed;
}

/**
 * Headers para propagar a correlação numa chamada de saída.
 *
 * Fora de requisição devolve objeto vazio, e não um id novo: um id que só existe
 * na chamada de saída não correlaciona com nada e daria falsa impressão de rastro.
 */
export function correlationHeaders(): Record<string, string> {
  const correlationId = currentCorrelationId();
  return correlationId ? { [CORRELATION_HEADER]: correlationId } : {};
}
