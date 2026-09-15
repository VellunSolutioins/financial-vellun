import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OpsAuditResult, OpsRole } from '@prisma/client';
import { Request } from 'express';

import { OpsAuditService } from '../../audit/ops-audit.service';
import { OPS_AUDIT_TARGETS } from '../../ops.constants';
import { OPS_ROLES } from '../decorators/ops-roles.decorator';

/**
 * Autoriza pelo papel declarado em `@OpsRoles(...)`. Deve rodar **depois** do
 * {@link OpsAuthGuard}, que popula `req.opsOperator`.
 *
 * Uma tentativa recusada deixa linha em `ops_audit_log` com `result: denied`:
 * saber quem tentou o que sem permissão é metade do valor de uma trilha de
 * auditoria, e é justamente o que um `403` silencioso perderia.
 */
@Injectable()
export class OpsRolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: OpsAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<OpsRole[] | undefined>(OPS_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Sem decorator, sessão válida basta: todo operador ativo é ao menos viewer.
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const operator = request.opsOperator;
    if (!operator) {
      // Rota com @OpsRoles mas sem OpsAuthGuard: erro de montagem, não de acesso.
      throw new Error('@OpsRoles exige OpsAuthGuard na mesma rota');
    }

    if (required.includes(operator.role)) return true;

    await this.audit.recordBestEffort({
      operatorId: operator.id,
      action: `${request.method} ${request.route?.path ?? request.path}`,
      targetType: OPS_AUDIT_TARGETS.operator,
      targetId: operator.id,
      reason: `papel ${operator.role} não está entre os autorizados (${required.join(', ')})`,
      result: OpsAuditResult.denied,
    });

    throw new ForbiddenException({
      statusCode: 403,
      code: 'OPS_ROLE_REQUIRED',
      message: 'Seu papel não permite esta ação.',
    });
  }
}
