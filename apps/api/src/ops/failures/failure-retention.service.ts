import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';

/** Teto de linhas por execução, para o expurgo não virar uma transação longa. */
const LOTE = 500;

@Injectable()
export class FailureRetentionService {
  private readonly logger = new Logger(FailureRetentionService.name);

  /**
   * Guarda de reentrância.
   *
   * Com mais de uma réplica da API, o `@Cron` dispara em todas. Esta guarda só
   * protege dentro do processo — duas réplicas ainda podem expurgar ao mesmo
   * tempo. É aceitável aqui porque o `deleteMany` é idempotente por natureza: a
   * segunda simplesmente não encontra as linhas que a primeira já removeu.
   */
  private rodando = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Expurga falhas cuja retenção venceu.
   *
   * De madrugada, porque uma varredura por `retentionUntil` compete com o
   * tráfego do dia e o resultado não muda por esperar algumas horas.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpired(): Promise<number> {
    if (this.rodando) {
      this.logger.warn('Expurgo anterior ainda em execução; pulando este ciclo');
      return 0;
    }
    this.rodando = true;

    try {
      let removidas = 0;
      // Em lotes para não segurar um lock longo sobre a tabela que o painel lê.
      for (;;) {
        const lote = await this.prisma.opsFailedMessage.findMany({
          where: { retentionUntil: { lt: new Date() } },
          select: { id: true },
          take: LOTE,
        });
        if (lote.length === 0) break;

        const { count } = await this.prisma.opsFailedMessage.deleteMany({
          where: { id: { in: lote.map((linha) => linha.id) } },
        });
        removidas += count;

        if (lote.length < LOTE) break;
      }

      if (removidas > 0) {
        this.logger.log(`Expurgo de falhas: ${removidas} linha(s) removida(s)`);
      }
      return removidas;
    } catch (error) {
      // Falhar o expurgo não pode derrubar o processo: o pior efeito é a tabela
      // crescer até a próxima execução.
      this.logger.error(
        'Falha no expurgo do catálogo',
        error instanceof Error ? error.stack : undefined,
      );
      return 0;
    } finally {
      this.rodando = false;
    }
  }
}
