import { ConsoleLogger, Injectable, LogLevel, OnApplicationShutdown, Scope } from '@nestjs/common';

import { currentCorrelationId } from './correlation';
import { LokiTransport } from './loki-transport';
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
 * Isso vale só para o **terminal**. Com `LOKI_PUSH_URL` definido, o Loki recebe
 * JSON nos dois ambientes.
 *
 * O `event` é o nome estável da ocorrência (o contexto do Nest, normalmente o
 * nome da classe). A mensagem varia; o `event` não — é por ele que se agrupa.
 */
@Injectable({ scope: Scope.DEFAULT })
export class AppLoggerService extends ConsoleLogger implements OnApplicationShutdown {
  private readonly env = process.env.NODE_ENV ?? 'development';
  private readonly structured = process.env.NODE_ENV === 'production';

  /**
   * Envio ao Loki, ativo só quando `LOKI_PUSH_URL` está definido.
   *
   * Sem a variável o transporte não existe — e é assim de propósito: em
   * desenvolvimento não há Alloy, e um transporte tentando conectar em nada
   * geraria ruído sem benefício.
   */
  private readonly loki = this.createTransport();

  private createTransport(): LokiTransport | null {
    const url = process.env.LOKI_PUSH_URL?.trim();
    if (!url) return null;

    return new LokiTransport({
      url,
      // Poucos labels e todos de conjunto fechado: no Loki, label é índice, e
      // `correlationId` como label criaria um stream por requisição. Ele fica no
      // **corpo** da linha, onde um filtro o encontra sem custo de cardinalidade.
      labels: { service: SERVICE, env: this.env },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    // Descarrega o buffer no encerramento; do contrário o log que explica um
    // shutdown problemático é exatamente o que se perde.
    await this.loki?.stop();
  }

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
      this.emitToConsole(level, message, rest);

      // O formato do terminal e o envio ao Loki são decisões independentes: o
      // texto colorido existe para quem lê o console, não para o agregador.
      // Antes o `return` do bloco acima vinha primeiro, e fora de produção o
      // transporte era criado mas nunca recebia uma linha — em silêncio.
      if (this.loki) this.loki.push(this.serialize(level, message, rest));
      return;
    }

    const serialized = this.serialize(level, message, rest);

    // `process.stdout` direto: `console.log` acrescentaria formatação em objeto
    // grande. O stdout continua recebendo tudo — o envio ao Loki é adicional, não
    // substituto, então uma falha lá deixa o log no Railway de qualquer forma.
    process.stdout.write(`${serialized}\n`);
    this.loki?.push(serialized);
  }

  private emitToConsole(level: LogLevel, message: unknown, rest: unknown[]): void {
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

  /** A linha em JSON, no formato que o Loki e o stdout de produção recebem. */
  private serialize(level: LogLevel, message: unknown, rest: unknown[]): string {
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

    return JSON.stringify({ ...line, message: payload.message });
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
