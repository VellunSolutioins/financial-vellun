import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LogMailTransport } from './transports/log-mail.transport';
import { MailTransport } from './transports/mail-transport.interface';
import { ResendMailTransport } from './transports/resend-mail.transport';

/**
 * Envio de e-mails transacionais. O canal é escolhido por `MAIL_PROVIDER`
 * (`log` em desenvolvimento, `resend` em produção) — mesmo padrão do messenger
 * do agente de IA. Envios são **best-effort**: falhas são logadas e nunca
 * vazam para a resposta HTTP (senão revelariam se um e-mail existe).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: MailTransport;

  constructor(config: ConfigService) {
    this.transport = this.createTransport(config);
  }

  /** Envia o link de redefinição de senha. Resolve sempre, mesmo em falha. */
  async sendPasswordReset(to: string, name: string, resetUrl: string): Promise<void> {
    const subject = 'Redefinição de senha — Financial Vellun';
    const text = [
      `Olá, ${name}.`,
      '',
      'Recebemos um pedido para redefinir a senha da sua conta no Financial Vellun.',
      'Abra o link abaixo para criar uma nova senha (válido por 1 hora e de uso único):',
      '',
      resetUrl,
      '',
      'Se você não pediu a redefinição, ignore este e-mail — sua senha continua a mesma.',
    ].join('\n');

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#111827;max-width:480px;margin:0 auto;padding:24px">
        <h1 style="font-size:20px;margin:0 0 16px">Redefinição de senha</h1>
        <p style="margin:0 0 12px">Olá, ${escapeHtml(name)}.</p>
        <p style="margin:0 0 12px">
          Recebemos um pedido para redefinir a senha da sua conta no <strong>Financial Vellun</strong>.
          Clique no botão abaixo para criar uma nova senha.
        </p>
        <p style="margin:0 0 20px">
          <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px">
            Criar nova senha
          </a>
        </p>
        <p style="margin:0 0 12px;font-size:14px;color:#4b5563">
          O link é de uso único e expira em 1 hora. Se o botão não funcionar, copie e cole este endereço no navegador:<br />
          <span style="word-break:break-all">${resetUrl}</span>
        </p>
        <p style="margin:0;font-size:14px;color:#4b5563">
          Se você não pediu a redefinição, ignore este e-mail — sua senha continua a mesma.
        </p>
      </div>
    `.trim();

    try {
      await this.transport.send({ to, subject, html, text });
    } catch (error) {
      this.logger.warn(
        `Falha ao enviar e-mail de redefinição para ${to}: ${(error as Error).message}`,
      );
    }
  }

  private createTransport(config: ConfigService): MailTransport {
    const provider = (config.get<string>('MAIL_PROVIDER') ?? 'log').toLowerCase();

    if (provider === '' || provider === 'log' || provider === 'none') {
      return new LogMailTransport();
    }

    if (provider === 'resend') {
      const apiKey = config.get<string>('RESEND_API_KEY');
      const from = config.get<string>('MAIL_FROM');
      if (apiKey && from) {
        return new ResendMailTransport(apiKey, from);
      }
      this.logger.warn(
        'MAIL_PROVIDER=resend sem RESEND_API_KEY/MAIL_FROM; usando o transport de log',
      );
      return new LogMailTransport();
    }

    this.logger.warn(`MAIL_PROVIDER desconhecido: ${provider}; usando o transport de log`);
    return new LogMailTransport();
  }
}

/** Escapa o que vai interpolado no corpo HTML (nome do usuário). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
