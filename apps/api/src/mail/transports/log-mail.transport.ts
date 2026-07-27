import { Logger } from '@nestjs/common';
import { MailMessage, MailTransport } from './mail-transport.interface';

/**
 * Transport de desenvolvimento: não envia nada, apenas registra o conteúdo no
 * console (é assim que se pega o link de redefinição rodando local).
 */
export class LogMailTransport implements MailTransport {
  private readonly logger = new Logger(LogMailTransport.name);

  async send(message: MailMessage): Promise<void> {
    this.logger.log(`[mail:log] para=${message.to} assunto="${message.subject}"\n${message.text}`);
  }
}
