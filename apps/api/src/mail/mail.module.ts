import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LogMailTransport } from './log-mail.transport';
import { MAIL_TRANSPORT, MailTransport } from './mail-transport';
import { MailService } from './mail.service';
import { ResendMailTransport } from './resend-mail.transport';

/**
 * Transporte por `MAIL_PROVIDER`: `log` (padrão; imprime no console) ou
 * `resend` (exige `RESEND_API_KEY` e `MAIL_FROM`). Valor desconhecido ou
 * `resend` sem as chaves derruba a API na subida, em vez de perder e-mails em
 * silêncio.
 */
export function createMailTransport(config: ConfigService): MailTransport {
  const provider = (config.get<string>('MAIL_PROVIDER') || 'log').trim().toLowerCase();

  if (provider === 'log') {
    return new LogMailTransport(config.get<string>('NODE_ENV') === 'production');
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
