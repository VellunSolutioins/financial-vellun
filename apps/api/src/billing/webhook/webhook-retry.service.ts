import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WebhookEventStatus } from '@prisma/client';

import { MetricsService } from '../../observability/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AttemptOutcome, WebhookProcessor } from './webhook.processor';

/** Eventos por ciclo. Acima disso, sobra para o minuto seguinte. */
const LOTE = 50;

/**
 * Quanto tempo um evento pode ficar `processing` antes de ser considerado preso.
 *
 * Acontece quando o processo morre no meio de uma tentativa — um deploy, um
 * OOM. Sem isto, o evento ficaria `processing` para sempre: a varredura procura
 * `failed`, e ninguém mais olharia para ele.
 */
const PRESO_APOS_MINUTOS = 15;

export interface RetrySweepSummary {
  destravados: number;
  tentados: number;
  processados: number;
  reagendados: number;
  esgotados: number;
}

/**
 * Varre os eventos de webhook com retry vencido.
 *
 * É o que dá durabilidade **sem introduzir fila nova**: o agendamento já está em
 * `next_retry_at`, e este cron é apenas quem olha o relógio. Um deploy no meio
 * de uma janela de retry deixa de perder o evento — na pior das hipóteses ele
 * espera até o próximo minuto.
 */
@Injectable()
export class WebhookRetryService {
  private readonly logger = new Logger(WebhookRetryService.name);

  /**
   * Guarda de reentrância dentro do processo. Com várias réplicas, duas podem
   * varrer ao mesmo tempo — e é por isso que a reivindicação do evento é um
   * `updateMany` atômico, não um `update`.
   */
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: WebhookProcessor,
    private readonly metrics: MetricsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'billing-webhook-retry' })
  async sweep(): Promise<RetrySweepSummary> {
    const vazio: RetrySweepSummary = {
      destravados: 0,
      tentados: 0,
      processados: 0,
      reagendados: 0,
      esgotados: 0,
    };

    if (this.rodando) {
      this.logger.warn('Varredura anterior ainda em execução; pulando este ciclo');
      return vazio;
    }
    this.rodando = true;

    try {
      const destravados = await this.destravarPresos();

      // A cada ciclo, a fila de retry vira gauge. Um `collect()` que consultasse
      // o banco a cada scrape amarraria a coleta de métrica à saúde do Postgres
      // — e é justamente quando ele vacila que o scrape precisa funcionar.
      this.metrics.setPaymentWebhookPendingRetry(
        await this.prisma.paymentWebhookEvent.count({
          where: { status: WebhookEventStatus.failed },
        }),
      );

      const vencidos = await this.prisma.paymentWebhookEvent.findMany({
        where: { status: WebhookEventStatus.failed, nextRetryAt: { lte: new Date() } },
        select: { id: true },
        // Mais antigos primeiro: um evento que espera há duas horas não pode
        // ficar atrás de um que acabou de falhar.
        orderBy: { nextRetryAt: 'asc' },
        take: LOTE,
      });

      const resumo: RetrySweepSummary = { ...vazio, destravados, tentados: vencidos.length };

      for (const evento of vencidos) {
        const desfecho = await this.processor.attempt(evento.id);
        this.contabilizar(resumo, desfecho);
      }

      if (resumo.tentados > 0 || resumo.destravados > 0) {
        this.logger.log(
          `Varredura de webhooks: ${resumo.destravados} destravado(s), ${resumo.tentados} tentado(s), ` +
            `${resumo.processados} processado(s), ${resumo.reagendados} reagendado(s), ` +
            `${resumo.esgotados} esgotado(s)`,
        );
      }
      return resumo;
    } catch (error) {
      // Falhar a varredura não pode derrubar o processo: o pior efeito é os
      // eventos esperarem o próximo minuto.
      this.logger.error(
        'Falha na varredura de retry de webhooks',
        error instanceof Error ? error.stack : undefined,
      );
      return vazio;
    } finally {
      this.rodando = false;
    }
  }

  /**
   * Devolve à fila os eventos presos em `processing`.
   *
   * Marcados como `failed` com `nextRetryAt` agora, em vez de processados
   * direto: assim eles passam pelo mesmo caminho de todo mundo, incluindo a
   * reivindicação atômica e a contagem de tentativas.
   */
  private async destravarPresos(): Promise<number> {
    const limite = new Date(Date.now() - PRESO_APOS_MINUTOS * 60 * 1000);

    const { count } = await this.prisma.paymentWebhookEvent.updateMany({
      where: { status: WebhookEventStatus.processing, attemptedAt: { lt: limite } },
      data: { status: WebhookEventStatus.failed, nextRetryAt: new Date() },
    });

    if (count > 0) {
      this.logger.warn(`${count} evento(s) presos em processing devolvidos à fila de retry`);
    }
    return count;
  }

  private contabilizar(resumo: RetrySweepSummary, desfecho: AttemptOutcome): void {
    if (desfecho === 'processed') resumo.processados += 1;
    else if (desfecho === 'retry_scheduled') resumo.reagendados += 1;
    else if (desfecho === 'exhausted') resumo.esgotados += 1;
  }
}
