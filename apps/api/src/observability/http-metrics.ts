import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request } from 'express';

import { UNMATCHED_ROUTE } from './metrics.service';

/**
 * Rótulos de rota e status compartilhados pelo interceptor e pelo filtro de
 * exceção, para que as duas fontes da mesma métrica não divirjam.
 */

/**
 * Padrão da rota casada pelo Express — o Nest registra o caminho completo, então
 * isto é `/transactions/:id`, não `/transactions/<uuid>`.
 *
 * Sem padrão (404 de rota inexistente) devolve {@link UNMATCHED_ROUTE}. Nunca cai
 * no path concreto: uma varredura de vulnerabilidade criaria uma série por URL
 * tentada e estouraria o limite de séries do free tier em minutos.
 */
export function routeLabel(request: Request): string {
  return request.route?.path ?? UNMATCHED_ROUTE;
}

/**
 * Status da resposta a partir da **exceção**, não de `response.statusCode`.
 *
 * Esta é a correção de um erro sutil: quando o handler lança, o interceptor roda
 * antes do filtro de exceção, então `response.statusCode` ainda é 200 — e a
 * requisição que falhou era contabilizada como sucesso. Um `/health/ready`
 * devolvendo 503 aparecia na métrica como 200, o que é o oposto de útil: o painel
 * juraria que está tudo bem.
 */
export function statusFromException(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();

  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    if (exception.code === 'P2002') return HttpStatus.CONFLICT;
    if (exception.code === 'P2025') return HttpStatus.NOT_FOUND;
  }
  if (exception instanceof Prisma.PrismaClientValidationError) {
    return HttpStatus.BAD_REQUEST;
  }

  return HttpStatus.INTERNAL_SERVER_ERROR;
}

/** Duração desde o primeiro middleware. `0` se a marcação não aconteceu. */
export function elapsedSeconds(request: Request): number {
  if (request.startedAt === undefined) return 0;
  return Number(process.hrtime.bigint() - request.startedAt) / 1e9;
}
