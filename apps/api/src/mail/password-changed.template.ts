import { MailMessage } from './mail-transport';
import { escapeHtml, firstName } from './password-reset.template';

export interface PasswordChangedMail {
  to: string;
  name: string;
  changedAt: Date;
  /** `reset`: pelo link de "Esqueci minha senha"; `change`: logado, em Minha Conta. */
  reason: 'reset' | 'change';
  /** Número de WhatsApp vinculado à conta, se houver. Só os 4 últimos dígitos vão no e-mail. */
  linkedPhone: string | null;
  forgotPasswordUrl: string;
  accountUrl: string;
}

const WHEN = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'long',
  timeStyle: 'short',
});

/** `(41) 99999-1234` → `1234`. O e-mail não carrega o número inteiro. */
function lastDigits(phone: string): string {
  return phone.replace(/\D/g, '').slice(-4);
}

/**
 * Aviso de que a senha mudou. Quem não reconhece a troca tem o caminho de
 * volta ("Esqueci minha senha"); quem retoma a conta de um invasor fica sabendo
 * do WhatsApp vinculado e de onde desvinculá-lo.
 */
export function passwordChangedMessage(mail: PasswordChangedMail): MailMessage {
  const name = firstName(mail.name);
  const greeting = name ? `Olá, ${name}!` : 'Olá!';
  const when = `${WHEN.format(mail.changedAt)} (horário de Brasília)`;
  const how =
    mail.reason === 'reset'
      ? 'A troca foi feita pelo link de "Esqueci minha senha", e a conta foi desconectada de todos os aparelhos.'
      : 'A troca foi feita em Minha Conta, e a conta foi desconectada dos outros aparelhos.';
  const phone = mail.linkedPhone ? lastDigits(mail.linkedPhone) : null;
  const whatsapp = phone
    ? `Sua conta tem um WhatsApp vinculado, com final ${phone}. Se você não reconhece esse número, desvincule em Minha Conta:`
    : null;

  const text = [
    greeting,
    '',
    `A senha da sua conta no Financial Vellun foi alterada em ${when}.`,
    how,
    '',
    'Se foi você, não precisa fazer nada.',
    '',
    'Se não foi você, crie uma senha nova agora:',
    mail.forgotPasswordUrl,
    ...(whatsapp ? ['', whatsapp, mail.accountUrl] : []),
  ].join('\n');

  const forgotUrl = escapeHtml(mail.forgotPasswordUrl);
  const accountUrl = escapeHtml(mail.accountUrl);
  const html = `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;">
      <tr>
        <td style="padding:32px 24px;font-size:16px;line-height:1.5;">
          <p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 16px;">A senha da sua conta no Financial Vellun foi alterada em ${escapeHtml(when)}.</p>
          <p style="margin:0 0 24px;font-size:14px;color:#4b5563;">${escapeHtml(how)}</p>
          <p style="margin:0 0 16px;">Se foi você, não precisa fazer nada. Se não foi, crie uma senha nova agora:</p>
          <p style="margin:0 0 24px;">
            <a href="${forgotUrl}" style="display:inline-block;padding:14px 24px;border-radius:10px;background:#111827;color:#ffffff;text-decoration:none;font-weight:bold;">Criar senha nova</a>
          </p>${
            whatsapp
              ? `
          <p style="margin:0;font-size:14px;color:#4b5563;">${escapeHtml(whatsapp)}<br><a href="${accountUrl}" style="color:#111827;">Abrir Minha Conta</a></p>`
              : ''
          }
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { to: mail.to, subject: 'Sua senha foi alterada — Financial Vellun', text, html };
}
