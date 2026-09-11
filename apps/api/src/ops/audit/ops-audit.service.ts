import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { OpsAuditResult, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export interface RecordAuditInput {
  operatorId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  reason?: string | null;
  result: OpsAuditResult;
  /** Correlaciona as linhas de uma mesma operação (um lote, por exemplo). */
  operationId?: string;
  beforeState?: Prisma.InputJsonValue | null;
  afterState?: Prisma.InputJsonValue | null;
}

/**
 * Trilha append-only das ações de operadores.
 *
 * O serviço expõe **apenas** escrita de linha nova e leitura. Não há `update`
 * nem `delete` — e a garantia não depende disso: a migration instala triggers
 * que recusam `UPDATE`, `DELETE` e `TRUNCATE` na tabela.
 */
@Injectable()
export class OpsAuditService {
  private readonly logger = new Logger(OpsAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Um id para agrupar todas as linhas de uma operação. */
  newOperationId(): string {
    return randomUUID();
  }

  /**
   * Grava a linha. Falha alto — use onde a auditoria e pre-condicao da acao.
   *
   * `tx` permite gravar **dentro da mesma transacao** que muda o estado do alvo.
   * Sem isso, descartar uma falha e registrar o descarte seriam dois passos, e
   * uma queda entre eles deixaria a acao feita e sem rastro — justamente o que
   * uma trilha de auditoria nao pode permitir.
   */
  async record(input: RecordAuditInput, tx?: Prisma.TransactionClient): Promise<string> {
    const operationId = input.operationId ?? this.newOperationId();
    const db = tx ?? this.prisma;

    const entry = await db.opsAuditLog.create({
      data: {
        operatorId: input.operatorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        reason: input.reason ?? null,
        result: input.result,
        operationId,
        beforeState: input.beforeState ?? undefined,
        afterState: input.afterState ?? undefined,
      },
      select: { id: true },
    });

    return entry.id;
  }

  /**
   * Registra sem propagar falha.
   *
   * Para uso **só** onde a ação principal já aconteceu e não pode ser desfeita
   * (uma mensagem já republicada, por exemplo): perder a linha de auditoria é
   * ruim, mas devolver erro depois do efeito seria pior. Onde a auditoria é
   * pré-condição — negar acesso, marcar como descartado — use {@link record},
   * que falha alto.
   */
  async recordBestEffort(input: RecordAuditInput): Promise<void> {
    try {
      await this.record(input);
    } catch (error) {
      this.logger.error(
        `Falha ao gravar auditoria de ${input.action} (alvo ${input.targetType}/${input.targetId ?? '-'})`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
