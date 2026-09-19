import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OpsAuditResult, OpsFailureSource, OpsFailureStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { OpsAuditService } from '../audit/ops-audit.service';
import { CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';
import { AgentReprocessClient } from './agent-reprocess.client';
import { retentionFor } from './ops-failed-messages.service';
import { routeForSource } from './reprocess-destinations';

/**
 * Desfecho de um item.
 *
 * Os quatro estados que o plano exige que sejam distintos e visíveis moram aqui
 * e no catálogo, não numa mensagem de texto:
 *
 * - **solicitação aceita** — a linha saiu de `pending` e está `reprocessing`;
 * - **mensagem republicada** — `republished`, linha em `reprocessed`;
 * - **processamento concluído** — *não é um estado desta tela*: a mensagem
 *   republicada volta ao pipeline e some daqui. Só o pipeline sabe se terminou;
 * - **nova falha** — uma linha **nova** no catálogo, com a mesma correlação
 *   (`dedupeKey` inclui `failedAt`, então falhar de novo nunca sobrescreve).
 */
export type ReprocessItemOutcome =
  | 'republished'
  | 'skipped'
  | 'rejected'
  | 'unresolved'
  | 'not_attempted';

export interface ReprocessItemResult {
  id: string;
  outcome: ReprocessItemOutcome;
  detail?: string;
}

export interface ReprocessBatchResult {
  /** Agrupa todas as linhas de auditoria deste lote. */
  operationId: string;
  items: ReprocessItemResult[];
  /** `true` quando o lote parou antes do fim por falha sistêmica. */
  aborted: boolean;
  abortReason?: string;
}

/**
 * Quantos `unresolved` seguidos bastam para concluir que o problema não é do
 * item, e sim do agente ou do broker.
 *
 * Insistir nos outros 47 itens só produziria 47 linhas presas em `reprocessing`
 * para o cron limpar depois — e mais nada.
 */
const FALHAS_SISTEMICAS_SEGUIDAS = 3;

/** Erro interno de fluxo: a linha não estava elegível quando fomos reivindicá-la. */
class NaoElegivel extends Error {}

@Injectable()
export class OpsFailuresActionsService {
  private readonly logger = new Logger(OpsFailuresActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OpsAuditService,
    private readonly agent: AgentReprocessClient,
  ) {}

  /** Reprocessa uma falha. Açúcar sobre o lote, para não haver dois caminhos. */
  async reprocessOne(
    id: string,
    reason: string,
    operator: CurrentOpsOperator,
  ): Promise<ReprocessItemResult> {
    const existe = await this.prisma.opsFailedMessage.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existe) throw new NotFoundException('Falha não encontrada.');

    const resultado = await this.reprocessMany([id], reason, operator);
    return resultado.items[0];
  }

  /**
   * Reprocessa um lote.
   *
   * **Sequencial, de propósito.** Concorrência aqui compraria pouco (cada
   * publicação é um confirm de milissegundos quando o broker está de pé) e
   * custaria a precisão da interrupção: com paralelismo, "parou no item 7" vira
   * "parou em algum lugar entre o 5 e o 12", e é exatamente essa fronteira que o
   * operador precisa saber para retomar.
   */
  async reprocessMany(
    ids: string[],
    reason: string,
    operator: CurrentOpsOperator,
  ): Promise<ReprocessBatchResult> {
    const operationId = this.audit.newOperationId();
    const items: ReprocessItemResult[] = [];

    let seguidasSemDesfecho = 0;
    let abortReason: string | undefined;

    for (const [indice, id] of ids.entries()) {
      if (abortReason) {
        items.push({ id, outcome: 'not_attempted' });
        continue;
      }

      const resultado = await this.reprocessItem(id, reason, operator, operationId);
      items.push(resultado);

      if (resultado.outcome === 'unresolved') {
        seguidasSemDesfecho += 1;
        if (seguidasSemDesfecho >= FALHAS_SISTEMICAS_SEGUIDAS) {
          abortReason = `${seguidasSemDesfecho} republicações seguidas sem desfecho; o lote parou no item ${indice + 1} de ${ids.length}`;
          this.logger.error(`Lote de reprocessamento interrompido: ${abortReason}`);
        }
      } else {
        seguidasSemDesfecho = 0;
      }
    }

    return { operationId, items, aborted: Boolean(abortReason), abortReason };
  }

  private async reprocessItem(
    id: string,
    reason: string,
    operator: CurrentOpsOperator,
    operationId: string,
  ): Promise<ReprocessItemResult> {
    let linha: { source: OpsFailureSource; payload: unknown; correlationId: string | null };

    try {
      // Reivindicar e auditar na MESMA transação: sem isso, uma queda entre os
      // dois passos deixaria a linha reivindicada sem registro de quem pediu.
      linha = await this.prisma.$transaction(async (tx) => {
        // `updateMany` com `status: pending` no `where` é o cadeado: duas
        // solicitações simultâneas sobre a mesma falha, só uma muda a linha.
        const { count } = await tx.opsFailedMessage.updateMany({
          where: { id, status: OpsFailureStatus.pending },
          // `lastOperationId` liga a linha do catalogo as linhas da trilha desta
          // operacao — e o que permite ir de "esta falha" para "o que aconteceu
          // com ela" sem procurar por data.
          data: { status: OpsFailureStatus.reprocessing, lastOperationId: operationId },
        });
        if (count === 0) throw new NaoElegivel();

        const alvo = await tx.opsFailedMessage.findUniqueOrThrow({
          where: { id },
          select: { source: true, payload: true, correlationId: true },
        });

        await this.audit.record(
          {
            operatorId: operator.id,
            action: OPS_AUDIT_ACTIONS.failureReprocessRequested,
            targetType: OPS_AUDIT_TARGETS.failedMessage,
            targetId: id,
            reason,
            result: OpsAuditResult.success,
            operationId,
            beforeState: { status: OpsFailureStatus.pending },
            afterState: { status: OpsFailureStatus.reprocessing },
          },
          tx,
        );

        return alvo;
      });
    } catch (error) {
      if (error instanceof NaoElegivel) {
        return { id, outcome: 'skipped', detail: 'a falha não está pendente' };
      }
      // A auditoria falhou depois da reivindicação e a transação desfez tudo: a
      // linha continua `pending`, então tentar de novo é seguro.
      this.logger.error(
        `Não foi possível reivindicar a falha ${id}`,
        error instanceof Error ? error.stack : undefined,
      );
      return { id, outcome: 'skipped', detail: 'não foi possível registrar a solicitação' };
    }

    const desfecho = await this.agent.republish({
      route: routeForSource(linha.source),
      payload: linha.payload,
      correlationId: linha.correlationId,
    });

    if (desfecho.status === 'published') {
      const agora = new Date();
      await this.prisma.opsFailedMessage.updateMany({
        where: { id, status: OpsFailureStatus.reprocessing },
        data: {
          status: OpsFailureStatus.reprocessed,
          reprocessedAt: agora,
          // O que já foi republicado não precisa ocupar espaço tanto quanto o
          // que ainda espera ação.
          retentionUntil: retentionFor(OpsFailureStatus.reprocessed, agora),
        },
      });

      // Best-effort: a mensagem já está no broker e não há como desfazer isso.
      // Devolver erro agora faria o operador reprocessar de novo.
      await this.audit.recordBestEffort({
        operatorId: operator.id,
        action: OPS_AUDIT_ACTIONS.failureReprocessPublished,
        targetType: OPS_AUDIT_TARGETS.failedMessage,
        targetId: id,
        reason,
        result: OpsAuditResult.success,
        operationId,
        beforeState: { status: OpsFailureStatus.reprocessing },
        afterState: { status: OpsFailureStatus.reprocessed },
      });

      return { id, outcome: 'republished' };
    }

    if (desfecho.status === 'rejected') {
      // Certeza de que nada foi publicado: a falha volta a ser trabalho a fazer.
      await this.prisma.opsFailedMessage.updateMany({
        where: { id, status: OpsFailureStatus.reprocessing },
        data: { status: OpsFailureStatus.pending },
      });

      await this.audit.recordBestEffort({
        operatorId: operator.id,
        action: OPS_AUDIT_ACTIONS.failureReprocessPublished,
        targetType: OPS_AUDIT_TARGETS.failedMessage,
        targetId: id,
        reason: `${reason} — recusado: ${desfecho.reason}`,
        result: OpsAuditResult.failure,
        operationId,
        beforeState: { status: OpsFailureStatus.reprocessing },
        afterState: { status: OpsFailureStatus.pending },
      });

      return { id, outcome: 'rejected', detail: desfecho.reason };
    }

    // `unknown`: a linha FICA em `reprocessing`. Devolvê-la a `pending` aqui
    // arriscaria uma segunda publicação da mesma mensagem; marcá-la como
    // `reprocessed` esconderia uma mensagem que talvez nunca tenha saído.
    await this.audit.recordBestEffort({
      operatorId: operator.id,
      action: OPS_AUDIT_ACTIONS.failureReprocessPublished,
      targetType: OPS_AUDIT_TARGETS.failedMessage,
      targetId: id,
      reason: `${reason} — sem desfecho: ${desfecho.reason}`,
      result: OpsAuditResult.failure,
      operationId,
      beforeState: { status: OpsFailureStatus.reprocessing },
      afterState: { status: OpsFailureStatus.reprocessing },
    });

    return { id, outcome: 'unresolved', detail: desfecho.reason };
  }

  /**
   * Descarta uma falha: ela nunca mais será reprocessada.
   *
   * Exige `ops_admin`, não `operator`. Reprocessar é reversível na prática (se
   * der errado, a mensagem volta ao catálogo); descartar é a decisão de que
   * aquela mensagem do cliente não vai ser atendida.
   */
  async discard(
    id: string,
    reason: string,
    operator: CurrentOpsOperator,
  ): Promise<{ id: string; status: OpsFailureStatus }> {
    const atual = await this.prisma.opsFailedMessage.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!atual) throw new NotFoundException('Falha não encontrada.');

    return this.prisma.$transaction(async (tx) => {
      const agora = new Date();
      // Só o que está `pending`. Uma linha em `reprocessing` pode já ter sido
      // publicada — descartá-la diria "não vamos atender" sobre uma mensagem que
      // talvez esteja sendo processada agora. O cron devolve essas a `pending`
      // primeiro; só então descartar significa alguma coisa.
      const { count } = await tx.opsFailedMessage.updateMany({
        where: { id, status: OpsFailureStatus.pending },
        data: {
          status: OpsFailureStatus.discarded,
          retentionUntil: retentionFor(OpsFailureStatus.discarded, agora),
        },
      });

      if (count === 0) {
        throw new NotFoundException(`Falha com status "${atual.status}" não pode ser descartada.`);
      }

      await this.audit.record(
        {
          operatorId: operator.id,
          action: OPS_AUDIT_ACTIONS.failureDiscarded,
          targetType: OPS_AUDIT_TARGETS.failedMessage,
          targetId: id,
          reason,
          result: OpsAuditResult.success,
          beforeState: { status: atual.status },
          afterState: { status: OpsFailureStatus.discarded },
        },
        tx,
      );

      return { id, status: OpsFailureStatus.discarded };
    });
  }
}
