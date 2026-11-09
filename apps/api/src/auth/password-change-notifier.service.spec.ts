import { PasswordChangeNotifier } from './password-change-notifier.service';

const USER = { id: 'user-1', name: 'Joao Grilo', email: 'joao@example.com' };

function createNotifier() {
  const mail = { sendPasswordChanged: jest.fn().mockResolvedValue(undefined) };
  const whatsappLink = { linkedPhone: jest.fn().mockResolvedValue('(19) 99999-1234') };
  const config = { get: jest.fn().mockReturnValue('https://app.example.com/') };
  const notifier = new PasswordChangeNotifier(mail as any, whatsappLink as any, config as any);
  return { mail, whatsappLink, notifier };
}

describe('PasswordChangeNotifier', () => {
  it('envia o aviso com os links do web e o WhatsApp vinculado', async () => {
    const { mail, whatsappLink, notifier } = createNotifier();
    const changedAt = new Date('2026-10-29T20:15:00Z');

    await notifier.send(USER, 'reset', changedAt);

    expect(whatsappLink.linkedPhone).toHaveBeenCalledWith(USER.id);
    expect(mail.sendPasswordChanged).toHaveBeenCalledWith({
      to: USER.email,
      name: USER.name,
      changedAt,
      reason: 'reset',
      linkedPhone: '(19) 99999-1234',
      forgotPasswordUrl: 'https://app.example.com/esqueci-senha',
      accountUrl: 'https://app.example.com/app/conta',
    });
  });

  it('notify não propaga falha de envio: só registra', async () => {
    const { mail, notifier } = createNotifier();
    mail.sendPasswordChanged.mockRejectedValue(new Error('Resend fora'));
    const logError = jest
      .spyOn((notifier as any).logger, 'error')
      .mockImplementation(() => undefined);

    expect(() => notifier.notify(USER, 'change')).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logError).toHaveBeenCalledWith(
      'Falha ao enviar o aviso de senha alterada',
      expect.any(String),
    );
  });
});
