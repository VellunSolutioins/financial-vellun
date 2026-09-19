import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import { OpsRole } from '@prisma/client';

/**
 * O operador da requisição corrente, resolvido pelo {@link OpsAuthGuard}.
 *
 * É o estado do banco no momento da requisição, não o do token: revogar um
 * papel tem efeito na próxima chamada, sem esperar a sessão expirar.
 */
export interface CurrentOpsOperator {
  id: string;
  githubLogin: string;
  role: OpsRole;
  canViewSensitive: boolean;
}

declare module 'express' {
  interface Request {
    opsOperator?: CurrentOpsOperator;
  }
}

export const CurrentOperator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentOpsOperator => {
    const request = context.switchToHttp().getRequest<Request>();
    const operator = request.opsOperator;

    if (!operator) {
      // Sinaliza erro de montagem (rota sem OpsAuthGuard), não falta de permissão.
      throw new Error('@CurrentOperator exige OpsAuthGuard na rota');
    }
    return operator;
  },
);
