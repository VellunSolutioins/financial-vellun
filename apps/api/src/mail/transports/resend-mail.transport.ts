import { Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { MailMessage, MailTransport } from './mail-transport.interface';

/** Envio real via Resend. Requer `RESEND_API_KEY` e `MAIL_FROM`. */
export class ResendMailTransport implements MailTransport {
  private readonly logger = new Logger(ResendMailTransport.name);
  private readonly resend: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.resend = new Resend(apiKey);
  }

  async send(message: MailMessage): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });

    // O SDK devolve o erro no retorno (não lança); normalizamos lançando para
    // que o MailService logue de forma única.
    if (error) {
      throw new Error(`Resend recusou o envio: ${error.name} - ${error.message}`);
    }

    this.logger.log(`E-mail "${message.subject}" enviado para ${message.to}`);
  }
}
