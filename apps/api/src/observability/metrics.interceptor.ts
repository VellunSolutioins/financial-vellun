import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import { elapsedSeconds, routeLabel, statusFromException } from './http-metrics';
import { MetricsService } from './metrics.service';

declare module 'express' {
  interface Request {
    /**
     * Marca que a requisição já foi contabilizada, para o
     * {@link AllExceptionsFilter} não contar de novo. Ver a nota no filtro.
     */
    metricsRecorded?: boolean;
  }
}

/**
 * Mede toda requisição que chega a um handler, com sucesso ou erro.
 *
 * A rota vem do **padrão** registrado (`/transactions/:id`), nunca do path
 * concreto: `/transactions/<uuid>` como label criaria uma série nova por
 * lançamento.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const record = (status: number) => {
      this.metrics.observeHttpRequest({
        method: request.method,
        route: routeLabel(request),
        status,
        durationSeconds: elapsedSeconds(request),
      });
      request.metricsRecorded = true;
    };

    // `tap` separa os dois desfechos porque o **status vem de lugares
    // diferentes**: no sucesso, de `response.statusCode` (o handler pode ter
    // devolvido 201 ou 204); no erro, da própria exceção — `response.statusCode`
    // ainda é 200 aqui, porque o filtro de exceção só roda depois. O `tap` não
    // engole o erro: ele segue para o filtro, já contabilizado.
    return next.handle().pipe(
      tap({
        complete: () => record(response.statusCode),
        error: (exception: unknown) => record(statusFromException(exception)),
      }),
    );
  }
}
