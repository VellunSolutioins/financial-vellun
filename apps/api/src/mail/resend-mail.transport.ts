import { MailDelivery, MailMessage, MailTransport } from './mail-transport';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

/**
 * Envio pela API HTTP do Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Chamada direta com `fetch`, sem o SDK: é um único POST, e assim não entra
 * dependência nova.
 */
export class ResendMailTransport implements MailTransport {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: MailMessage): Promise<MailDelivery> {
    const response = await this.fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`Resend respondeu ${response.status}: ${detail}`);
    }
    return 'sent';
  }
}
