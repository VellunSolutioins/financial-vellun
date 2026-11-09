import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PasswordResetService } from './password-reset.service';

/**
 * Limpeza diária dos links de redefinição vencidos (docs/retencao-e-backups.md).
 *
 * Com mais de uma réplica, o `@Cron` dispara em todas; tudo bem, o
 * `deleteMany` é idempotente e a segunda execução não encontra nada.
 */
@Injectable()
export class PasswordResetRetentionService {
  private readonly logger = new Logger(PasswordResetRetentionService.name);

  constructor(private readonly passwordReset: PasswordResetService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeExpired(): Promise<number> {
    try {
      const removidos = await this.passwordReset.purgeExpired();
      if (removidos > 0) {
        this.logger.log(`Links de redefinição vencidos removidos: ${removidos}`);
      }
      return removidos;
    } catch (error) {
      // O pior efeito de falhar é a tabela crescer até a próxima execução.
      this.logger.error(
        'Falha ao remover links de redefinição vencidos',
        error instanceof Error ? error.stack : undefined,
      );
      return 0;
    }
  }
}
