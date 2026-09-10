import { ConsoleLogger, Injectable, LogLevel, Scope } from '@nestjs/common';

import { currentCorrelationId } from './correlation';
import { sanitizeForLog } from './sanitize';

const SERVICE = 'api';

/** Campos fixos de toda linha, para o Loki poder filtrar sem parsear a mensagem. */
interface LogLine {
  timestamp: string;
  level: string;
  service: string;
  env: string;
  event: string;
  correlationId?: string;
  errorType?: string;
  context?: unknown;
  stack?: string;
}

/**
 * Logger JSON estruturado.
 *
 * Em produção emite uma linha JSON por log — o formato que o Loki indexa e que
 * permite `correlationId="..."` como consulta em vez de busca por substring. Em
 * desenvolvimento delega ao `ConsoleLogger` do Nest, porque JSON num terminal é
 * ilegível e ninguém depura assim.
 *
 * O `event` é o nome estável da ocorrência (o contexto do Nest, normalmente o
 * nome da classe). A mensagem varia; o `event` não — é por ele que se agrupa.
 */
@Injectable({ scope: Scope.DEFAULT })
export class AppLoggerService extends ConsoleLogger {
  private readonly env = process.env.NODE_ENV ?? 'development';
  private readonly structured = process.env.NODE_ENV === 'production';

  log(message: unknown, ...rest: unknown[]): void {
    this.emit('log', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('verbose', message, rest);
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[]): void {
    if (!this.structured) {
      // `super` espera (message, ...rest) e já trata contexto e cor.
      switch (level) {
        case 'error':
          super.error(message, ...(rest as [string]));
          return;
        case 'warn':
          super.warn(message, ...(rest as [string]));
          return;
        case 'debug':
          super.debug(message, ...(rest as [string]));
          return;
        case 'verbose':
          super.verbose(message, ...(rest as [string]));
          return;
        default:
          super.log(message, ...(rest as [string]));
          return;
      }
    }

    const { event, stack, extras } = splitRest(rest, this.context);
    const line: LogLine = {
      timestamp: new Date().toISOString(),
      level,
      service: SERVICE,
      env: this.env,
      event,
      correlationId: currentCorrelationId(),
      ...(stack ? { stack } : {}),
    };

    const payload = toPayload(message);
    if (payload.errorType) line.errorType = payload.errorType;
    if (extras.length > 0) line.context = sanitizeForLog(extras);

    // `process.stdout` direto: o Railway lê stdout e o repassa ao log drain, e
    // `console.log` acrescentaria formatação em objeto grande.
    process.stdout.write(`${JSON.stringify({ ...line, message: payload.message })}\n`);
  }
}

/**
 * O Nest passa o contexto (nome da classe) como **último** argumento variádico, e
 * `error()` pode receber um stack no meio. Separar as três coisas aqui evita que
 * o nome da classe apareça como se fosse dado de negócio.
 */
function splitRest(
  rest: unknown[],
  fallbackContext: string | undefined,
): { event: string; stack?: string; extras: unknown[] } {
  const items = [...rest];
  let event = fallbackContext ?? 'app';
  let stack: string | undefined;

  const last = items[items.length - 1];
  if (typeof last === 'string' && !last.includes('\n')) {
    event = last;
    items.pop();
  }

  const maybeStack = items[items.length - 1];
  if (typeof maybeStack === 'string' && maybeStack.includes('\n')) {
    stack = maybeStack;
    items.pop();
  }

  return { event, stack, extras: items };
}

function toPayload(message: unknown): { message: string; errorType?: string } {
  if (message instanceof Error) {
    return { message: message.message, errorType: message.name };
  }
  if (typeof message === 'string') return { message };
  return { message: JSON.stringify(sanitizeForLog(message)) };
}
