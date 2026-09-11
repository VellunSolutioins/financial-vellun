import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OpsAuditResult, OpsFailureStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { OpsAuditService } from '../audit/ops-audit.service';
import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';

/**
 * Quanto tempo uma linha pode ficar `reprocessing` antes de ser considerada
 * presa.
 *
 * Bem acima do tempo real da operação (o cliente do agente desiste em 15s), para
 * que uma republicação lenta nunca seja confundida com uma travada. Se a
 * publicação de fato aconteceu perto do limite, devolver a linha a `pending`
 * levaria, no pior caso, a uma segunda publicação — e é aí que entra a
 * idempotência do pipeline (`jobId`, `providerMessageId`, `idempotencyKey`), que
 * impede a segunda de virar um segundo lançamento.
 */
export const RECONCILIACAO_APOS_MINUTOS = 15;

/** Teto por execução, para não segurar lock longo sobre a tabela que o painel lê. */
const LOTE = 200;

/**
 * Devolve a `pending` as linhas presas em `reprocessing`.
 *
 * Elas existem porque **publicar e marcar não são atômicos** — o broker e o
 * Postgres são dois sistemas, e o plano não finge o contrário. Uma queda entre
 * os dois passos, ou um confirm que nunca chegou, deixa a linha reivindicada e
 * sem desfecho. Sem este cron ela ficaria invisível para sempre: não aparece nos
 * pendentes, e ninguém volta a olhar.
 */
@Injectable()
export class ReprocessReconciliationService {
  private readonly logger = new Logger(ReprocessReconciliationService.name);
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OpsAuditService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcile(): Promise<number> {
    if (this.rodando) {
      this.logger.warn('Reconciliação anterior ainda em execução; pulando este ciclo');
      return 0;
    }
    this.rodando = true;

    try {
      const limite = new Date(Date.now() - RECONCILIACAO_APOS_MINUTOS * 60 * 1000);

      const presas = await this.prisma.opsFailedMessage.findMany({
        where: { status: OpsFailureStatus.reprocessing, updatedAt: { lt: limite } },
        select: { id: true },
        take: LOTE,
      });
      if (presas.length === 0) return 0;

      let devolvidas = 0;
      for (const linha of presas) {
        const { count } = await this.prisma.opsFailedMessage.updateMany({
          where: { id: linha.id, status: OpsFailureStatus.reprocessing },
          data: { status: OpsFailureStatus.pending },
        });
        if (count === 0) continue;

        devolvidas += count;
        await this.registrar(linha.id);
      }

      if (devolvidas > 0) {
        this.logger.warn(
          `Reconciliação: ${devolvidas} falha(s) presa(s) em reprocessing voltaram a pending`,
        );
      }
      return devolvidas;
    } catch (error) {
      // Falhar a reconciliação não pode derrubar o processo: o pior efeito é as
      // linhas seguirem presas até o próximo ciclo.
      this.logger.error(
        'Falha na reconciliação de reprocessamentos',
        error instanceof Error ? error.stack : undefined,
      );
      return 0;
    } finally {
      this.rodando = false;
    }
  }

  /**
   * Registra a devolução na trilha.
   *
   * A trilha responde "quem fez", e um cron não é ninguém. A linha é atribuída
   * ao operador que **pediu** o reprocessamento — que é, de fato, quem levou a
   * falha a este estado — com uma justificativa que diz que o sistema a
   * devolveu. Se não houver esse registro (uma linha vinda de migração antiga,
   * por exemplo), a devolução fica só no log: inventar um operador seria pior do
   * que a ausência.
   */
  private async registrar(failureId: string): Promise<void> {
    const solicitacao = await this.prisma.opsAuditLog.findFirst({
      where: {
        targetType: OPS_AUDIT_TARGETS.failedMessage,
        targetId: failureId,
        action: OPS_AUDIT_ACTIONS.failureReprocessRequested,
      },
      orderBy: { createdAt: 'desc' },
      select: { operatorId: true, operationId: true },
    });

    if (!solicitacao) {
      this.logger.warn(
        `Falha ${failureId} devolvida a pending sem linha de auditoria: não há solicitação registrada`,
      );
      return;
    }

    await this.audit.recordBestEffort({
      operatorId: solicitacao.operatorId,
      action: OPS_AUDIT_ACTIONS.failureReprocessPublished,
      targetType: OPS_AUDIT_TARGETS.failedMessage,
      targetId: failureId,
      reason: `reconciliação automática: presa em reprocessing por mais de ${RECONCILIACAO_APOS_MINUTOS} min`,
      result: OpsAuditResult.failure,
      operationId: solicitacao.operationId,
      beforeState: { status: OpsFailureStatus.reprocessing },
      afterState: { status: OpsFailureStatus.pending },
    });
  }
}
