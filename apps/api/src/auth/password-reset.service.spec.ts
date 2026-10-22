import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import {
  FORGOT_PASSWORD_MESSAGE,
  INVALID_RESET_LINK_MESSAGE,
  PasswordResetService,
  RESET_REQUEST_COOLDOWN_SECONDS,
  RESET_TOKEN_TTL_MINUTES,
  hashResetToken,
} from './password-reset.service';

// Senha de teste gerada, para não haver credencial literal no código.
const NEW_PASSWORD = 'n'.repeat(12);
const TOKEN = 'a'.repeat(64);

const USER = { id: 'user-1', name: 'Joao Grilo', email: 'joao@example.com' };

function createMocks() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    passwordResetToken: {
      findFirst: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
    user: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue(USER) },
    passwordResetToken: {
      findUnique: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const sessions = { revokeAllForUser: jest.fn().mockResolvedValue(3) };
  const securityEvents = { record: jest.fn().mockResolvedValue(undefined) };
  const mail = { sendPasswordReset: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue('https://app.example.com/') };
  const service = new PasswordResetService(
    prisma as any,
    sessions as any,
    securityEvents as any,
    mail as any,
    config as any,
  );
  return { tx, prisma, sessions, securityEvents, mail, config, service };
}

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'token-1',
    userId: USER.id,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    ...overrides,
  };
}

describe('PasswordResetService', () => {
  describe('requestReset', () => {
    it('responde o mesmo corpo, com os prazos, sem esperar o envio', () => {
      const { service, mail } = createMocks();
      mail.sendPasswordReset.mockReturnValue(new Promise(() => undefined));

      expect(service.requestReset('joao@example.com')).toEqual({
        message: FORGOT_PASSWORD_MESSAGE,
        expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
        retryAfterSeconds: RESET_REQUEST_COOLDOWN_SECONDS,
      });
    });

    it('não propaga falha do processamento', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findFirst.mockRejectedValue(new Error('db fora'));
      const logError = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation(() => undefined);

      expect(service.requestReset('joao@example.com').message).toBe(FORGOT_PASSWORD_MESSAGE);
      await new Promise((resolve) => setImmediate(resolve));
      expect(logError).toHaveBeenCalled();
    });
  });

  describe('issueAndSend', () => {
    it('gera o token, guarda só o hash e envia o link', async () => {
      const { service, prisma, tx, mail, securityEvents } = createMocks();

      await expect(service.issueAndSend('  Joao@Example.com ', { ip: '1.2.3.4' })).resolves.toBe(
        true,
      );

      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: { equals: 'joao@example.com', mode: 'insensitive' } },
        }),
      );
      // Links anteriores invalidados antes de criar o novo.
      expect(tx.passwordResetToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER.id },
      });

      const { resetUrl, to, expiresInMinutes } = mail.sendPasswordReset.mock.calls[0][0];
      expect(to).toBe(USER.email);
      expect(expiresInMinutes).toBe(RESET_TOKEN_TTL_MINUTES);
      const match = /^https:\/\/app\.example\.com\/redefinir-senha\?token=([a-f0-9]{64})$/.exec(
        resetUrl,
      );
      expect(match).not.toBeNull();

      const data = tx.passwordResetToken.create.mock.calls[0][0].data;
      expect(data.tokenHash).toBe(hashResetToken(match![1]));
      expect(data.tokenHash).not.toBe(match![1]);
      const ttl = data.expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan((RESET_TOKEN_TTL_MINUTES - 1) * 60_000);
      expect(ttl).toBeLessThanOrEqual(RESET_TOKEN_TTL_MINUTES * 60_000);

      expect(securityEvents.record).toHaveBeenCalledWith(USER.id, 'password_reset_requested', {
        ip: '1.2.3.4',
      });
    });

    it('trava a conta antes de checar o intervalo (pedidos simultâneos)', async () => {
      const { service, tx } = createMocks();
      const order: string[] = [];
      tx.$executeRaw.mockImplementation(async () => {
        order.push('lock');
        return 1;
      });
      tx.passwordResetToken.findFirst.mockImplementation(async () => {
        order.push('cooldown');
        return null;
      });

      await service.issueAndSend(USER.email);

      expect(order).toEqual(['lock', 'cooldown']);
      // O lock é por conta: a chave leva o id do usuário.
      const [, key] = tx.$executeRaw.mock.calls[0];
      expect(key).toBe(`password-reset:${USER.id}`);
    });

    it('e-mail sem conta: não abre transação nem envia nada', async () => {
      const { service, prisma, mail } = createMocks();
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.issueAndSend('ninguem@example.com')).resolves.toBe(false);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(mail.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('segura um segundo e-mail dentro do intervalo mínimo', async () => {
      const { service, tx, mail, securityEvents } = createMocks();
      tx.passwordResetToken.findFirst.mockResolvedValue({ id: 'recente' });

      await expect(service.issueAndSend(USER.email)).resolves.toBe(false);

      expect(tx.passwordResetToken.create).not.toHaveBeenCalled();
      expect(mail.sendPasswordReset).not.toHaveBeenCalled();
      expect(securityEvents.record).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('troca a senha, apaga os links e encerra as sessões na mesma transação', async () => {
      const { service, prisma, tx, sessions, securityEvents } = createMocks();
      prisma.passwordResetToken.findUnique.mockResolvedValue(tokenRow());

      const result = await service.resetPassword(TOKEN, NEW_PASSWORD, { ip: '1.2.3.4' });

      expect(result.message).toMatch(/Senha redefinida/);
      expect(prisma.passwordResetToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: hashResetToken(TOKEN) } }),
      );
      // Consome (apaga) o token usado e depois os demais da conta.
      expect(tx.passwordResetToken.deleteMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'token-1', expiresAt: { gt: expect.any(Date) } },
      });
      expect(tx.passwordResetToken.deleteMany).toHaveBeenNthCalledWith(2, {
        where: { userId: USER.id },
      });

      const { passwordHash } = tx.user.update.mock.calls[0][0].data;
      expect(await bcrypt.compare(NEW_PASSWORD, passwordHash)).toBe(true);

      // Revogação com o cliente da transação.
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(USER.id, undefined, tx);
      expect(securityEvents.record).toHaveBeenCalledWith(USER.id, 'password_reset', {
        ip: '1.2.3.4',
        metadata: { sessoesEncerradas: 3 },
      });
    });

    it('falha ao revogar as sessões: a transação inteira falha', async () => {
      const { service, prisma, sessions, securityEvents } = createMocks();
      prisma.passwordResetToken.findUnique.mockResolvedValue(tokenRow());
      sessions.revokeAllForUser.mockRejectedValue(new Error('pool esgotado'));

      await expect(service.resetPassword(TOKEN, NEW_PASSWORD)).rejects.toThrow('pool esgotado');
      // A falha sai de dentro do $transaction, que desfaz a troca de senha.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(securityEvents.record).not.toHaveBeenCalled();
    });

    it.each([
      ['inexistente', null],
      ['expirado', tokenRow({ expiresAt: new Date(Date.now() - 1000) })],
    ])('recusa token %s', async (_label, row) => {
      const { service, prisma, tx, sessions } = createMocks();
      prisma.passwordResetToken.findUnique.mockResolvedValue(row);

      const error = await service.resetPassword(TOKEN, NEW_PASSWORD).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: INVALID_RESET_LINK_MESSAGE,
        errors: [{ field: 'token', message: INVALID_RESET_LINK_MESSAGE }],
      });
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('recusa quando outro envio consumiu o token no meio do caminho', async () => {
      const { service, prisma, tx, sessions } = createMocks();
      prisma.passwordResetToken.findUnique.mockResolvedValue(tokenRow());
      tx.passwordResetToken.deleteMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.resetPassword(TOKEN, NEW_PASSWORD)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('purgeExpired', () => {
    it('apaga os links vencidos', async () => {
      const { service, prisma } = createMocks();
      prisma.passwordResetToken.deleteMany.mockResolvedValue({ count: 4 });
      const now = new Date('2026-10-21T12:00:00Z');

      await expect(service.purgeExpired(now)).resolves.toBe(4);
      expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: now } },
      });
    });
  });
});
