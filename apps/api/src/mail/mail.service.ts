import { Inject, Injectable } from '@nestjs/common';

import { MAIL_TRANSPORT } from './mail-transport';
import type { MailTransport } from './mail-transport';
import { PasswordResetMail, passwordResetMessage } from './password-reset.template';

/** E-mails transacionais. Quem chama decide o que fazer com uma falha de envio. */
@Injectable()
export class MailService {
  constructor(@Inject(MAIL_TRANSPORT) private readonly transport: MailTransport) {}

  sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    return this.transport.send(passwordResetMessage(mail));
  }
}
