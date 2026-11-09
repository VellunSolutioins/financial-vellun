import { ConfigService } from '@nestjs/config';

import { LogMailTransport } from './log-mail.transport';
import { createMailTransport } from './mail.module';
import { MailService } from './mail.service';
import { passwordChangedMessage } from './password-changed.template';
import { escapeHtml, passwordResetMessage } from './password-reset.template';
import { ResendMailTransport } from './resend-mail.transport';

const RESET_URL = 'http://localhost:3000/redefinir-senha#token=abc123';

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
    expect(message.html).toContain('href="http://localhost:3000/redefinir-senha#token=abc123"');
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

  it('sem nome no cadastro, a saudação é só "Olá!"', () => {
    const message = passwordResetMessage({
      to: 'x@example.com',
      name: '   ',
      resetUrl: RESET_URL,
      expiresInMinutes: 60,
    });

    expect(message.text.startsWith('Olá!\n')).toBe(true);
    expect(message.text).not.toContain('Olá, olá');
    expect(message.html).toContain('>Olá!</p>');
  });

  it('escapeHtml cobre aspas e &', () => {
    expect(escapeHtml(`a&b"c'd`)).toBe('a&amp;b&quot;c&#39;d');
  });
});

describe('createMailTransport', () => {
  it('fora de produção, ausente vira log', () => {
    expect(createMailTransport(config({})).name).toBe('log');
  });

  it('em produção, MAIL_PROVIDER ausente derruba a subida', () => {
    expect(() => createMailTransport(config({ NODE_ENV: 'production' }))).toThrow(
      /obrigatório em produção/,
    );
    expect(() =>
      createMailTransport(config({ NODE_ENV: 'production', MAIL_PROVIDER: '  ' })),
    ).toThrow(/obrigatório em produção/);
  });

  it('em produção, log só quando escrito de propósito', () => {
    expect(createMailTransport(config({ NODE_ENV: 'production', MAIL_PROVIDER: 'log' })).name).toBe(
      'log',
    );
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
    await expect(transport.send(message)).resolves.toBe('sent');
    expect(log).toHaveBeenCalledWith(expect.stringContaining(RESET_URL));
  });

  it('em produção não escreve o link e informa que não enviou', async () => {
    const transport = new LogMailTransport(true);
    const logger = (transport as any).logger;
    const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await expect(transport.send(message)).resolves.toBe('skipped');
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.not.stringContaining(RESET_URL));
  });
});

describe('ResendMailTransport', () => {
  const message = { to: 'a@b.com', subject: 'Assunto', text: 'texto', html: '<p>html</p>' };

  it('faz o POST com a chave e o remetente', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    const transport = new ResendMailTransport('re_key', 'App <app@x.com>', fetchMock as any);

    await expect(transport.send(message)).resolves.toBe('sent');

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

describe('passwordChangedMessage', () => {
  const base = {
    to: 'joao@example.com',
    name: 'Joao Grilo',
    // 29/10/2026 20:15 UTC = 17:15 em Brasília.
    changedAt: new Date('2026-10-29T20:15:00Z'),
    reason: 'reset' as const,
    linkedPhone: null,
    forgotPasswordUrl: 'http://localhost:3000/esqueci-senha',
    accountUrl: 'http://localhost:3000/app/conta',
  };

  it('diz quando mudou, no horário de Brasília, e como voltar', () => {
    const message = passwordChangedMessage(base);

    expect(message.to).toBe('joao@example.com');
    expect(message.subject).toMatch(/senha foi alterada/);
    expect(message.text).toContain('Olá, Joao!');
    expect(message.text).toContain('29 de outubro de 2026');
    expect(message.text).toContain('17:15');
    expect(message.text).toContain('"Esqueci minha senha"');
    expect(message.text).toContain(base.forgotPasswordUrl);
    expect(message.html).toContain(`href="${base.forgotPasswordUrl}"`);
  });

  it('troca logada fala dos outros aparelhos', () => {
    const message = passwordChangedMessage({ ...base, reason: 'change' });
    expect(message.text).toContain('Minha Conta');
    expect(message.text).toContain('outros aparelhos');
  });

  it('com WhatsApp vinculado, mostra só o final do número e onde desvincular', () => {
    const message = passwordChangedMessage({ ...base, linkedPhone: '(19) 99999-1234' });

    expect(message.text).toContain('final 1234');
    expect(message.text).not.toContain('99999');
    expect(message.text).toContain(base.accountUrl);
    expect(message.html).toContain('final 1234');
    expect(message.html).not.toContain('99999');
    expect(message.html).toContain(`href="${base.accountUrl}"`);
  });

  it('sem WhatsApp vinculado, não fala dele', () => {
    const message = passwordChangedMessage(base);
    expect(message.text).not.toContain('WhatsApp');
    expect(message.html).not.toContain(base.accountUrl);
  });
});

describe('MailService', () => {
  function create(send: jest.Mock) {
    const metrics = { observeMail: jest.fn() };
    const service = new MailService({ name: 'fake', send } as any, metrics as any);
    return { metrics, service };
  }

  const reset = {
    to: 'a@b.com',
    name: 'A',
    resetUrl: RESET_URL,
    expiresInMinutes: 30,
  };

  it('conta o envio pelo desfecho do transporte', async () => {
    const { metrics, service } = create(jest.fn().mockResolvedValue('skipped'));

    await service.sendPasswordReset(reset);

    expect(metrics.observeMail).toHaveBeenCalledWith('password_reset', 'skipped');
  });

  it('falha conta como failed e propaga', async () => {
    const { metrics, service } = create(jest.fn().mockRejectedValue(new Error('fora do ar')));

    await expect(service.sendPasswordReset(reset)).rejects.toThrow('fora do ar');
    expect(metrics.observeMail).toHaveBeenCalledWith('password_reset', 'failed');
  });

  it('aviso de senha alterada tem template próprio na métrica', async () => {
    const send = jest.fn().mockResolvedValue('sent');
    const { metrics, service } = create(send);

    await service.sendPasswordChanged({
      to: 'a@b.com',
      name: 'A',
      changedAt: new Date(),
      reason: 'change',
      linkedPhone: null,
      forgotPasswordUrl: 'http://x/esqueci-senha',
      accountUrl: 'http://x/app/conta',
    });

    expect(send.mock.calls[0][0].subject).toMatch(/senha foi alterada/);
    expect(metrics.observeMail).toHaveBeenCalledWith('password_changed', 'sent');
  });
});
