import { Inject, Injectable } from '@nestjs/common';

import { MailTemplate, MetricsService } from '../observability/metrics.service';
import { MAIL_TRANSPORT } from './mail-transport';
import type { MailDelivery, MailMessage, MailTransport } from './mail-transport';
import { PasswordChangedMail, passwordChangedMessage } from './password-changed.template';
import { PasswordResetMail, passwordResetMessage } from './password-reset.template';

/**
 * E-mails transacionais. Quem chama decide o que fazer com uma falha de envio;
 * aqui ela só é contada (`vellun_api_mail_sent_total`) e relançada.
 */
@Injectable()
export class MailService {
  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    private readonly metrics: MetricsService,
  ) {}

  sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    return this.deliver('password_reset', passwordResetMessage(mail));
  }

  sendPasswordChanged(mail: PasswordChangedMail): Promise<void> {
    return this.deliver('password_changed', passwordChangedMessage(mail));
  }

  private async deliver(template: MailTemplate, message: MailMessage): Promise<void> {
    let delivery: MailDelivery;
    try {
      delivery = await this.transport.send(message);
    } catch (error) {
      this.metrics.observeMail(template, 'failed');
      throw error;
    }
    this.metrics.observeMail(template, delivery);
  }
}
