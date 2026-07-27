export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Canal de envio de e-mail. Implementações não devem lançar: falhas são logadas. */
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}
