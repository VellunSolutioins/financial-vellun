import { PasswordResetRetentionService } from './password-reset-retention.service';

describe('PasswordResetRetentionService', () => {
  it('delega a limpeza e devolve quantos removeu', async () => {
    const passwordReset = { purgeExpired: jest.fn().mockResolvedValue(2) };
    const service = new PasswordResetRetentionService(passwordReset as any);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);

    await expect(service.purgeExpired()).resolves.toBe(2);
  });

  it('não derruba o processo quando a limpeza falha', async () => {
    const passwordReset = { purgeExpired: jest.fn().mockRejectedValue(new Error('db fora')) };
    const service = new PasswordResetRetentionService(passwordReset as any);
    const logError = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    await expect(service.purgeExpired()).resolves.toBe(0);
    expect(logError).toHaveBeenCalled();
  });
});
