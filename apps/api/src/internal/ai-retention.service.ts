import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service';

/** Teto de linhas por rodada, para o expurgo não virar uma transação longa. */
const LOTE = 500;
const DIAS_PADRAO = 90;
/** Substitui o texto original: a linha continua existindo, o conteúdo não. */
export const CONTEUDO_EXPURGADO = '[conteúdo removido por retenção]';

/**
 * Retenção do conteúdo das conversas com a IA (plano de segurança, S4).
 *
 * `ai_messages.content` e `ai_extracted_transactions.raw_input` guardam o que a
 * pessoa escreveu — inclusive o que ela mandou por engano. Passado o prazo,
 * nada disso é necessário: o lançamento criado já vive em `transactions`, e o
 * histórico recente que alimenta o contexto do agente é de dias, não de meses.
 *
 * O expurgo **apaga o texto e mantém a linha**: as métricas de volume, a
 * idempotência por `providerMessageId` e o encadeamento das conversas
 * continuam de pé.
 */
@Injectable()
export class AiRetentionService {
  private readonly logger = new Logger(AiRetentionService.name);
  private readonly dias: number;
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const configurado = Number(config.get<string>('AI_CONTENT_RETENTION_DAYS'));
    this.dias = Number.isFinite(configurado) && configurado >= 0 ? configurado : DIAS_PADRAO;
  }

  /** De madrugada: a varredura compete com o tráfego do dia e pode esperar. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeExpired(): Promise<{ mensagens: number; extracoes: number }> {
    if (this.dias === 0) return { mensagens: 0, extracoes: 0 };
    if (this.rodando) {
      this.logger.warn('Expurgo anterior ainda em execução; pulando este ciclo');
      return { mensagens: 0, extracoes: 0 };
    }
    this.rodando = true;

    const limite = new Date(Date.now() - this.dias * 24 * 60 * 60 * 1000);
    try {
      const mensagens = await this.purgarMensagens(limite);
      const extracoes = await this.purgarExtracoes(limite);
      if (mensagens > 0 || extracoes > 0) {
        this.logger.log(
          `Retenção de IA: ${mensagens} mensagem(ns) e ${extracoes} extração(ões) sem conteúdo`,
        );
      }
      return { mensagens, extracoes };
    } catch (error) {
      // O pior efeito de falhar é o conteúdo ficar até a próxima rodada.
      this.logger.error(
        'Falha no expurgo de conteúdo de IA',
        error instanceof Error ? error.stack : undefined,
      );
      return { mensagens: 0, extracoes: 0 };
    } finally {
      this.rodando = false;
    }
  }

  private async purgarMensagens(limite: Date): Promise<number> {
    let total = 0;
    // Em lotes: a tabela é lida pelo histórico que alimenta o agente.
    for (;;) {
      const lote = await this.prisma.aiMessage.findMany({
        where: { createdAt: { lt: limite }, content: { not: CONTEUDO_EXPURGADO } },
        select: { id: true },
        take: LOTE,
      });
      if (lote.length === 0) break;

      const { count } = await this.prisma.aiMessage.updateMany({
        where: { id: { in: lote.map((linha) => linha.id) } },
        data: { content: CONTEUDO_EXPURGADO },
      });
      total += count;
      if (lote.length < LOTE) break;
    }
    return total;
  }

  private async purgarExtracoes(limite: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const lote = await this.prisma.aiExtractedTransaction.findMany({
        where: { createdAt: { lt: limite }, rawInput: { not: CONTEUDO_EXPURGADO } },
        select: { id: true },
        take: LOTE,
      });
      if (lote.length === 0) break;

      const { count } = await this.prisma.aiExtractedTransaction.updateMany({
        where: { id: { in: lote.map((linha) => linha.id) } },
        data: { rawInput: CONTEUDO_EXPURGADO },
      });
      total += count;
      if (lote.length < LOTE) break;
    }
    return total;
  }
}
