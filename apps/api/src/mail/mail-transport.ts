/** Mensagem pronta para envio: o conteúdo já vem renderizado em texto e HTML. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Desfecho de um envio bem-sucedido: `skipped` quando o transporte, de
 * propósito, não entregou (o `log` em produção). Falha é exceção.
 */
export type MailDelivery = 'sent' | 'skipped';

/**
 * Meio de entrega. A escolha é por `MAIL_PROVIDER` (`mail.module.ts`), no mesmo
 * espírito do messenger do WhatsApp: em dev o transporte `log` dispensa conta
 * em provedor e deixa o link visível no console.
 */
export interface MailTransport {
  readonly name: string;
  send(message: MailMessage): Promise<MailDelivery>;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
