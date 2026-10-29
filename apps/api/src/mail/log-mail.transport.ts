import { Logger } from '@nestjs/common';

import { MailDelivery, MailMessage, MailTransport } from './mail-transport';

/**
 * Não envia nada: escreve a mensagem no log da API. É assim que, em dev, se
 * pega o link de redefinição de senha.
 *
 * Em produção o corpo **não** é escrito: ele carrega o link de redefinição, e
 * quem lê o log poderia trocar a senha de qualquer um. Fica só o aviso de que
 * um e-mail deixou de ser enviado. Em produção este transporte só existe com
 * `MAIL_PROVIDER=log` escrito de propósito (ver `createMailTransport`).
 */
export class LogMailTransport implements MailTransport {
  readonly name = 'log';
  private readonly logger = new Logger('MailLog');

  constructor(private readonly production: boolean) {}

  async send(message: MailMessage): Promise<MailDelivery> {
    if (this.production) {
      this.logger.warn(`E-mail "${message.subject}" NÃO enviado: MAIL_PROVIDER=log em produção.`);
      return 'skipped';
    }
    this.logger.log(`Para: ${message.to}\nAssunto: ${message.subject}\n\n${message.text}`);
    return 'sent';
  }
}
