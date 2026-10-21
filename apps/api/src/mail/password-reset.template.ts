import { MailMessage } from './mail-transport';

export interface PasswordResetMail {
  to: string;
  name: string;
  resetUrl: string;
  expiresInMinutes: number;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** O nome vem do cadastro: escapado para não virar HTML no e-mail. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || 'olá';
}

export function passwordResetMessage(mail: PasswordResetMail): MailMessage {
  const greeting = firstName(mail.name);
  const validity =
    mail.expiresInMinutes % 60 === 0
      ? `${mail.expiresInMinutes / 60} hora${mail.expiresInMinutes === 60 ? '' : 's'}`
      : `${mail.expiresInMinutes} minutos`;

  const text = [
    `Olá, ${greeting}!`,
    '',
    'Recebemos um pedido para redefinir a senha da sua conta no Financial Vellun.',
    'Para criar uma senha nova, abra o link abaixo:',
    '',
    mail.resetUrl,
    '',
    `O link vale por ${validity} e só pode ser usado uma vez.`,
    'Ao trocar a senha, você sai da conta em todos os aparelhos.',
    '',
    'Se não foi você que pediu, ignore este e-mail: sua senha continua a mesma.',
  ].join('\n');

  const url = escapeHtml(mail.resetUrl);
  const html = `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;">
      <tr>
        <td style="padding:32px 24px;font-size:16px;line-height:1.5;">
          <p style="margin:0 0 16px;">Olá, ${escapeHtml(greeting)}!</p>
          <p style="margin:0 0 24px;">Recebemos um pedido para redefinir a senha da sua conta no Financial Vellun.</p>
          <p style="margin:0 0 24px;">
            <a href="${url}" style="display:inline-block;padding:14px 24px;border-radius:10px;background:#111827;color:#ffffff;text-decoration:none;font-weight:bold;">Criar senha nova</a>
          </p>
          <p style="margin:0 0 16px;font-size:14px;color:#4b5563;">O link vale por ${validity} e só pode ser usado uma vez. Ao trocar a senha, você sai da conta em todos os aparelhos.</p>
          <p style="margin:0 0 16px;font-size:14px;color:#4b5563;">Se o botão não abrir, copie este endereço no navegador:<br><span style="word-break:break-all;">${url}</span></p>
          <p style="margin:0;font-size:14px;color:#4b5563;">Se não foi você que pediu, ignore este e-mail: sua senha continua a mesma.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { to: mail.to, subject: 'Redefinição de senha — Financial Vellun', text, html };
}
