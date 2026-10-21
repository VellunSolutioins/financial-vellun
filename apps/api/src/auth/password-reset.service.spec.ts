import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import {
  FORGOT_PASSWORD_MESSAGE,
  INVALID_RESET_LINK_MESSAGE,
  PasswordResetService,
  RESET_TOKEN_TTL_MINUTES,
  hashResetToken,
} from './password-reset.service';

// Senha de teste gerada, para não haver credencial literal no código.
const NEW_PASSWORD = 'n'.repeat(12);
const TOKEN = 'a'.repeat(64);

const USER = { id: 'user-1', name: 'Joao Grilo', email: 'joao@example.com' };

function createMocks() {
  const tx = {
    passwordResetToken: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue(USER) },
    passwordResetToken: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      deleteMany: jest.fn().mockReturnValue('deleteMany-op'),
      create: jest.fn().mockReturnValue('create-op'),
    },
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (client: typeof tx) => unknown)(tx)
        : Promise.all(arg as unknown[]),
    ),
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
    usedAt: null,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    ...overrides,
  };
}

describe('PasswordResetService', () => {
  describe('requestReset', () => {
    it('responde a mesma mensagem genérica sem esperar o envio', () => {
      const { service, mail } = createMocks();
      mail.sendPasswordReset.mockReturnValue(new Promise(() => undefined));

      expect(service.requestReset('joao@example.com')).toEqual({
        message: FORGOT_PASSWORD_MESSAGE,
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
      const { service, prisma, mail, securityEvents } = createMocks();

      await service.issueAndSend('  Joao@Example.com ', { ip: '1.2.3.4' });

      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: { equals: 'joao@example.com', mode: 'insensitive' } },
        }),
      );
      // Links anteriores invalidados antes de criar o novo.
      expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER.id },
      });

      const { resetUrl, to, expiresInMinutes } = mail.sendPasswordReset.mock.calls[0][0];
      expect(to).toBe(USER.email);
      expect(expiresInMinutes).toBe(RESET_TOKEN_TTL_MINUTES);
      const match = /^https:\/\/app\.example\.com\/redefinir-senha\?token=([a-f0-9]{64})$/.exec(
        resetUrl,
      );
      expect(match).not.toBeNull();

      const data = prisma.passwordResetToken.create.mock.calls[0][0].data;
      expect(data.tokenHash).toBe(hashResetToken(match![1]));
      expect(data.tokenHash).not.toBe(match![1]);
      const ttl = data.expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan((RESET_TOKEN_TTL_MINUTES - 1) * 60_000);
      expect(ttl).toBeLessThanOrEqual(RESET_TOKEN_TTL_MINUTES * 60_000);

      expect(securityEvents.record).toHaveBeenCalledWith(USER.id, 'password_reset_requested', {
        ip: '1.2.3.4',
      });
    });

    it('e-mail sem conta: não cria token nem envia nada', async () => {
      const { service, prisma, mail } = createMocks();
      prisma.user.findFirst.mockResolvedValue(null);

      await service.issueAndSend('ninguem@example.com');

      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(mail.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('segura um segundo e-mail dentro do intervalo mínimo', async () => {
      const { service, prisma, mail } = createMocks();
      prisma.passwordResetToken.findFirst.mockResolvedValue({ id: 'recente' });

      await service.issueAndSend(USER.email);

      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(mail.sendPasswordReset).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('troca a senha, consome o token e encerra todas as sessões', async () => {
      const { service, prisma, tx, sessions, securityEvents } = createMocks();
      prisma.passwordResetToken.findUnique.mockResolvedValue(tokenRow());

      const result = await service.resetPassword(TOKEN, NEW_PASSWORD, { ip: '1.2.3.4' });

      expect(result.message).toMatch(/Senha redefinida/);
      expect(prisma.passwordResetToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: hashResetToken(TOKEN) } }),
      );
      expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'token-1', usedAt: null, expiresAt: { gt: expect.any(Date) } },
        data: { usedAt: expect.any(Date) },
      });

      const { passwordHash } = tx.user.update.mock.calls[0][0].data;
      expect(await bcrypt.compare(NEW_PASSWORD, passwordHash)).toBe(true);

      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(USER.id);
      expect(securityEvents.record).toHaveBeenCalledWith(USER.id, 'password_reset', {
        ip: '1.2.3.4',
        metadata: { sessoesEncerradas: 3 },
      });
    });

    it.each([
      ['inexistente', null],
      ['já usado', tokenRow({ usedAt: new Date() })],
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
      tx.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.resetPassword(TOKEN, NEW_PASSWORD)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    });
  });
});
