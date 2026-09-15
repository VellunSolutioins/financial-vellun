import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import {
  CORRELATION_HEADER,
  runWithCorrelationId,
  sanitizeIncomingCorrelationId,
} from './correlation';

declare module 'express' {
  interface Request {
    correlationId?: string;
    /**
     * Início da requisição, para a duração ser medida a partir do primeiro
     * middleware. Guardar aqui é o que permite ao filtro de exceção reportar a
     * duração real de uma requisição recusada **antes** do handler (um guard, por
     * exemplo), onde o interceptor nunca chega a rodar.
     */
    startedAt?: bigint;
  }
}

/**
 * Abre o contexto de correlação da requisição.
 *
 * Precisa ser o **primeiro** middleware: tudo que rodar antes dele — inclusive
 * um erro em outro middleware — fica sem correlação no log, que é justamente
 * quando ela seria mais útil.
 *
 * O id volta na resposta para que o cliente (e o painel de operações) consiga
 * levar o mesmo id ao Loki sem precisar adivinhar.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const correlationId = sanitizeIncomingCorrelationId(request.headers[CORRELATION_HEADER]);

    request.startedAt = process.hrtime.bigint();
    request.correlationId = correlationId;
    response.setHeader(CORRELATION_HEADER, correlationId);

    runWithCorrelationId(correlationId, next);
  }
}
