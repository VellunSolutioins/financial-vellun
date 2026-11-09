import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LogMailTransport } from './log-mail.transport';
import { MAIL_TRANSPORT, MailTransport } from './mail-transport';
import { MailService } from './mail.service';
import { ResendMailTransport } from './resend-mail.transport';

/**
 * Transporte por `MAIL_PROVIDER`: `resend` (exige `RESEND_API_KEY` e
 * `MAIL_FROM`) ou `log` (imprime no console). Configuração errada derruba a API
 * na subida, em vez de perder e-mails em silêncio:
 *
 * - valor desconhecido, ou `resend` sem as chaves;
 * - em produção, `MAIL_PROVIDER` ausente. Lá, `log` só vale escrito de
 *   propósito (um staging sem envio, por exemplo), nunca por omissão.
 *
 * Fora de produção, ausente vira `log`.
 */
export function createMailTransport(config: ConfigService): MailTransport {
  const production = config.get<string>('NODE_ENV') === 'production';
  const provider = config.get<string>('MAIL_PROVIDER')?.trim().toLowerCase();

  if (!provider) {
    if (production) {
      throw new Error(
        'MAIL_PROVIDER é obrigatório em produção. Use "resend" (ou "log" para não enviar ' +
          'e-mails de propósito).',
      );
    }
    return new LogMailTransport(false);
  }
  if (provider === 'log') {
    return new LogMailTransport(production);
  }
  if (provider === 'resend') {
    const apiKey = config.get<string>('RESEND_API_KEY')?.trim();
    const from = config.get<string>('MAIL_FROM')?.trim();
    if (!apiKey || !from) {
      throw new Error('MAIL_PROVIDER=resend exige RESEND_API_KEY e MAIL_FROM.');
    }
    return new ResendMailTransport(apiKey, from);
  }
  throw new Error(`MAIL_PROVIDER inválido: "${provider}". Use "log" ou "resend".`);
}

@Module({
  providers: [
    { provide: MAIL_TRANSPORT, useFactory: createMailTransport, inject: [ConfigService] },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
