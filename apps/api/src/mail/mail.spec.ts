import { ConfigService } from '@nestjs/config';

import { LogMailTransport } from './log-mail.transport';
import { createMailTransport } from './mail.module';
import { escapeHtml, passwordResetMessage } from './password-reset.template';
import { ResendMailTransport } from './resend-mail.transport';

const RESET_URL = 'http://localhost:3000/redefinir-senha?token=abc123';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('passwordResetMessage', () => {
  it('leva o link no texto e no HTML, com o primeiro nome e a validade', () => {
    const message = passwordResetMessage({
      to: 'joao@example.com',
      name: 'Joao Grilo',
      resetUrl: RESET_URL,
      expiresInMinutes: 60,
    });

    expect(message.to).toBe('joao@example.com');
    expect(message.text).toContain(RESET_URL);
    expect(message.text).toContain('Olá, Joao!');
    expect(message.text).toContain('1 hora');
    expect(message.html).toContain('href="http://localhost:3000/redefinir-senha?token=abc123"');
  });

  it('escapa o nome no HTML', () => {
    const message = passwordResetMessage({
      to: 'x@example.com',
      name: '<script>alert(1)</script>',
      resetUrl: RESET_URL,
      expiresInMinutes: 30,
    });

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.text).toContain('30 minutos');
  });

  it('escapeHtml cobre aspas e &', () => {
    expect(escapeHtml(`a&b"c'd`)).toBe('a&amp;b&quot;c&#39;d');
  });
});

describe('createMailTransport', () => {
  it('usa log por padrão', () => {
    expect(createMailTransport(config({})).name).toBe('log');
  });

  it('usa resend com chave e remetente', () => {
    const transport = createMailTransport(
      config({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', MAIL_FROM: 'a <a@b.com>' }),
    );
    expect(transport.name).toBe('resend');
  });

  it('recusa resend sem chave e provedor desconhecido', () => {
    expect(() => createMailTransport(config({ MAIL_PROVIDER: 'resend' }))).toThrow(
      /RESEND_API_KEY/,
    );
    expect(() => createMailTransport(config({ MAIL_PROVIDER: 'smtp' }))).toThrow(/inválido/);
  });
});

describe('LogMailTransport', () => {
  const message = { to: 'a@b.com', subject: 'Assunto', text: RESET_URL, html: '' };

  it('em dev escreve o corpo (é como se pega o link)', async () => {
    const transport = new LogMailTransport(false);
    const log = jest.spyOn((transport as any).logger, 'log').mockImplementation(() => undefined);
    await transport.send(message);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(RESET_URL));
  });

  it('em produção não escreve o link', async () => {
    const transport = new LogMailTransport(true);
    const logger = (transport as any).logger;
    const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await transport.send(message);
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.not.stringContaining(RESET_URL));
  });
});

describe('ResendMailTransport', () => {
  const message = { to: 'a@b.com', subject: 'Assunto', text: 'texto', html: '<p>html</p>' };

  it('faz o POST com a chave e o remetente', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    const transport = new ResendMailTransport('re_key', 'App <app@x.com>', fetchMock as any);

    await transport.send(message);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_key');
    expect(JSON.parse(init.body)).toEqual({
      from: 'App <app@x.com>',
      to: ['a@b.com'],
      subject: 'Assunto',
      text: 'texto',
      html: '<p>html</p>',
    });
  });

  it('falha quando o Resend recusa', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 422, text: async () => 'invalid from' });
    const transport = new ResendMailTransport('re_key', 'x', fetchMock as any);

    await expect(transport.send(message)).rejects.toThrow('Resend respondeu 422: invalid from');
  });
});
