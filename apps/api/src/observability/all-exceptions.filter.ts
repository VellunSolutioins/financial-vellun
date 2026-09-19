import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { CORRELATION_HEADER, currentCorrelationId } from './correlation';
import { elapsedSeconds, routeLabel, statusFromException } from './http-metrics';
import { MetricsService } from './metrics.service';
import { sanitizeForLog } from './sanitize';

/**
 * Filtro global de exceções.
 *
 * Faz três coisas que faltavam:
 *
 * 1. **loga toda exceção** de forma estruturada, com `errorType` e correlação —
 *    antes, um 500 aparecia só como stack cru do Nest;
 * 2. **sanitiza o corpo** devolvido e o logado. O corpo de um `BadRequestException`
 *    do `ValidationPipe` ecoa os campos recusados, e isso já inclui telefone e
 *    e-mail; sanitizar só o que é persistido deixaria esse caminho aberto;
 * 3. **contabiliza a requisição que nunca chegou a um handler** (404 de rota
 *    inexistente), que o {@link MetricsInterceptor} não vê. Sem isso uma varredura
 *    de vulnerabilidade não aparece em métrica nenhuma.
 */
@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly metrics: MetricsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const status = statusFromException(exception);
    const body = this.buildBody(exception, status);

    this.record(request, status);
    this.log(exception, request, status);

    // O header pode não ter sido escrito se o erro veio antes do middleware.
    const correlationId = request.correlationId ?? currentCorrelationId();
    if (correlationId && !response.headersSent) {
      response.setHeader(CORRELATION_HEADER, correlationId);
    }

    if (response.headersSent) {
      // Resposta já em voo (erro durante o streaming): só encerra. Escrever
      // agora estouraria "Cannot set headers after they are sent".
      response.end();
      return;
    }

    response.status(status).json(body);
  }

  /**
   * Só contabiliza o que o interceptor não viu.
   *
   * O interceptor marca `metricsRecorded`. Escapam dele dois casos, e os dois
   * importam: o 404 de rota inexistente (nunca há handler) e a recusa por guard
   * ou pipe, que roda **antes** dos interceptores — um 403 de assinatura ou um
   * 401 de chave interna só aparece em métrica por aqui.
   */
  private record(request: Request, status: number): void {
    if (request.metricsRecorded) return;

    this.metrics.observeHttpRequest({
      method: request.method ?? 'GET',
      route: routeLabel(request),
      status,
      durationSeconds: elapsedSeconds(request),
    });
  }

  private buildBody(exception: unknown, status: number): Record<string, unknown> {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'string') {
        return { statusCode: status, message: response };
      }
      return sanitizeForLog(response) as Record<string, unknown>;
    }

    // Erro não previsto: a mensagem interna nunca vai para o cliente — pode
    // carregar SQL, caminho de arquivo ou fragmento de payload.
    return {
      statusCode: status,
      message: 'Erro interno do servidor.',
    };
  }

  private log(exception: unknown, request: Request, status: number): void {
    const errorType = exception instanceof Error ? exception.name : typeof exception;
    const message = exception instanceof Error ? exception.message : String(exception);
    // A rota é o padrão, não o path: mesma razão da métrica, e mantém a linha
    // de log agrupável.
    const summary = `${request.method} ${routeLabel(request)} → ${status} (${errorType}): ${message}`;

    // 4xx é comportamento esperado do cliente (validação, permissão) e não deve
    // acordar ninguém; 5xx é falha nossa.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(summary, exception instanceof Error ? exception.stack : undefined);
      return;
    }
    this.logger.warn(summary);
  }
}
