import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { webUrl } from '../common/web-url.util';
import { MailService } from '../mail/mail.service';
import { WhatsappLinkService } from '../whatsapp-link/whatsapp-link.service';

export interface PasswordChangedUser {
  id: string;
  email: string;
  name: string;
}

/**
 * E-mail "sua senha foi alterada", na redefinição e na troca logada.
 *
 * Leva o WhatsApp vinculado (só o final do número): a redefinição não desfaz o
 * vínculo, então quem retoma a conta de um invasor precisa saber que ele existe
 * e onde desvinculá-lo.
 */
@Injectable()
export class PasswordChangeNotifier {
  private readonly logger = new Logger(PasswordChangeNotifier.name);

  constructor(
    private readonly mail: MailService,
    private readonly whatsappLink: WhatsappLinkService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Dispara o aviso sem esperar. A senha já mudou: uma falha de envio não pode
   * virar erro para quem acabou de trocá-la. Ela fica no log e na métrica.
   */
  notify(user: PasswordChangedUser, reason: 'reset' | 'change'): void {
    void this.send(user, reason).catch((error: unknown) => {
      this.logger.error(
        'Falha ao enviar o aviso de senha alterada',
        error instanceof Error ? error.stack : undefined,
      );
    });
  }

  /** Monta e envia o aviso. Separado de `notify` para os testes. */
  async send(
    user: PasswordChangedUser,
    reason: 'reset' | 'change',
    changedAt = new Date(),
  ): Promise<void> {
    const base = webUrl(this.config);
    await this.mail.sendPasswordChanged({
      to: user.email,
      name: user.name,
      changedAt,
      reason,
      linkedPhone: await this.whatsappLink.linkedPhone(user.id),
      forgotPasswordUrl: `${base}/esqueci-senha`,
      accountUrl: `${base}/app/conta`,
    });
  }
}
