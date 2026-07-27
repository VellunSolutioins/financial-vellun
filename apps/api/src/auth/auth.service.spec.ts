import { createHash } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import { AccountType, ProfileType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('AuthService', () => {
  it('creates an individual profile and a default account when registering a PF user', async () => {
    const createdUser = {
      id: 'user-1',
      name: 'Joao Grilo',
      email: 'joao@example.com',
      passwordHash: 'hashed',
      profileType: ProfileType.individual,
      phone: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const tx = {
      user: {
        create: jest.fn().mockResolvedValue(createdUser),
      },
      individualProfile: {
        create: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      },
      businessProfile: {
        create: jest.fn(),
      },
      account: {
        create: jest.fn().mockResolvedValue({ id: 'account-1' }),
      },
      whatsappContact: {
        upsert: jest.fn().mockResolvedValue({ id: 'whatsapp-1' }),
      },
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      whatsappContact: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      individualProfile: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      businessProfile: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn((callback) => callback(tx)),
    };

    const welcomeNotification = { sendWelcome: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(
      prisma as any,
      {} as any,
      {} as any,
      welcomeNotification as any,
      { sendPasswordReset: jest.fn() } as any,
    );

    const result = await service.register({
      name: 'Joao Grilo',
      email: 'joao@example.com',
      phone: '(19) 99999-9999',
      password: 'password123',
      profileType: ProfileType.individual,
      cpf: '123.456.789-09',
    });

    expect(welcomeNotification.sendWelcome).toHaveBeenCalledWith({
      phone: '+5519999999999',
      name: 'Joao Grilo',
      profileType: ProfileType.individual,
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'joao@example.com' },
    });
    expect(prisma.individualProfile.findUnique).toHaveBeenCalledWith({
      where: { cpf: '123.456.789-09' },
    });
    expect(tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Joao Grilo',
        email: 'joao@example.com',
        phone: '(19) 99999-9999',
        profileType: ProfileType.individual,
      }),
    });
    expect(tx.individualProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        cpf: '123.456.789-09',
      }),
    });
    expect(tx.businessProfile.create).not.toHaveBeenCalled();
    expect(tx.account.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        name: 'Conta Principal',
        type: AccountType.checking,
        initialBalance: 0,
        currentBalance: 0,
        currency: 'BRL',
      },
    });
    expect(tx.whatsappContact.upsert).toHaveBeenCalledWith({
      where: { phoneNumber: '+5519999999999' },
      update: {
        userId: 'user-1',
        provider: 'cloud-api',
        isVerified: true,
      },
      create: {
        userId: 'user-1',
        phoneNumber: '+5519999999999',
        provider: 'cloud-api',
        isVerified: true,
      },
    });
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('creates a business profile and a default account when registering a PJ user', async () => {
    const createdUser = {
      id: 'user-2',
      name: 'Padaria do Joao',
      email: 'contato@padaria.com',
      passwordHash: 'hashed',
      profileType: ProfileType.business,
      phone: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const tx = {
      user: {
        create: jest.fn().mockResolvedValue(createdUser),
      },
      individualProfile: {
        create: jest.fn(),
      },
      businessProfile: {
        create: jest.fn().mockResolvedValue({ id: 'profile-2' }),
      },
      account: {
        create: jest.fn().mockResolvedValue({ id: 'account-2' }),
      },
      whatsappContact: {
        upsert: jest.fn().mockResolvedValue({ id: 'whatsapp-2' }),
      },
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      whatsappContact: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      individualProfile: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      businessProfile: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn((callback) => callback(tx)),
    };

    const welcomeNotification = { sendWelcome: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(
      prisma as any,
      {} as any,
      {} as any,
      welcomeNotification as any,
      { sendPasswordReset: jest.fn() } as any,
    );

    const result = await service.register({
      name: 'Padaria do Joao',
      email: 'contato@padaria.com',
      phone: '(19) 98888-7777',
      password: 'password123',
      profileType: ProfileType.business,
      companyName: 'Padaria do Joao LTDA',
      tradeName: 'Padaria do Joao',
      cnpj: '12.345.678/0001-99',
    });

    expect(welcomeNotification.sendWelcome).toHaveBeenCalledWith({
      phone: '+5519988887777',
      name: 'Padaria do Joao',
      profileType: ProfileType.business,
    });

    expect(prisma.businessProfile.findUnique).toHaveBeenCalledWith({
      where: { cnpj: '12.345.678/0001-99' },
    });
    expect(tx.businessProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-2',
        companyName: 'Padaria do Joao LTDA',
        tradeName: 'Padaria do Joao',
        cnpj: '12.345.678/0001-99',
      }),
    });
    expect(tx.individualProfile.create).not.toHaveBeenCalled();
    expect(tx.account.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-2',
        name: 'Conta Principal',
        type: AccountType.checking,
        initialBalance: 0,
        currentBalance: 0,
        currency: 'BRL',
      },
    });
    expect(tx.whatsappContact.upsert).toHaveBeenCalledWith({
      where: { phoneNumber: '+5519988887777' },
      update: {
        userId: 'user-2',
        provider: 'cloud-api',
        isVerified: true,
      },
      create: {
        userId: 'user-2',
        phoneNumber: '+5519988887777',
        provider: 'cloud-api',
        isVerified: true,
      },
    });
    expect(result).not.toHaveProperty('passwordHash');
  });
});

describe('AuthService — recuperação de senha', () => {
  const GENERIC_MESSAGE =
    'Se o e-mail estiver cadastrado, enviamos um link para redefinir a senha.';

  function buildService(prismaOverrides: Record<string, unknown>) {
    const prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      passwordResetToken: {
        deleteMany: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn().mockResolvedValue([]),
      ...prismaOverrides,
    };
    const config = { get: jest.fn().mockReturnValue('http://localhost:3000') };
    const mail = { sendPasswordReset: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(
      prisma as any,
      {} as any,
      config as any,
      {} as any,
      mail as any,
    );
    return { service, prisma, mail };
  }

  it('gera um token e envia o e-mail quando o endereço existe', async () => {
    const { service, prisma, mail } = buildService({
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'user-1', email: 'joao@example.com', name: 'Joao Grilo' }),
        update: jest.fn(),
      },
    });

    const result = await service.forgotPassword({ email: 'joao@example.com' });

    // Pedidos anteriores ainda não usados são descartados.
    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', usedAt: null },
    });

    expect(mail.sendPasswordReset).toHaveBeenCalledTimes(1);
    const [to, name, resetUrl] = mail.sendPasswordReset.mock.calls[0];
    expect(to).toBe('joao@example.com');
    expect(name).toBe('Joao Grilo');

    // O link carrega o token em claro; o banco guarda apenas o hash.
    const token = new URL(resetUrl).searchParams.get('token')!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const created = prisma.passwordResetToken.create.mock.calls[0][0].data;
    expect(created.userId).toBe('user-1');
    expect(created.tokenHash).toBe(sha256(token));
    expect(created.tokenHash).not.toBe(token);
    expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(result).toEqual({ message: GENERIC_MESSAGE });
  });

  it('responde a mesma mensagem sem criar token quando o e-mail não existe', async () => {
    const { service, prisma, mail } = buildService({
      user: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
    });

    const result = await service.forgotPassword({ email: 'ninguem@example.com' });

    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    expect(mail.sendPasswordReset).not.toHaveBeenCalled();
    expect(result).toEqual({ message: GENERIC_MESSAGE });
  });

  it('troca a senha e marca o token como usado', async () => {
    const token = 'a'.repeat(64);
    const { service, prisma } = buildService({
      passwordResetToken: {
        deleteMany: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({
          id: 'token-1',
          userId: 'user-1',
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + 60_000),
          usedAt: null,
        }),
        update: jest.fn(),
      },
    });

    const result = await service.resetPassword({ token, newPassword: 'novaSenha123' });

    expect(prisma.passwordResetToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: sha256(token) },
    });

    const updateArgs = prisma.user.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'user-1' });
    expect(await bcrypt.compare('novaSenha123', updateArgs.data.passwordHash)).toBe(true);

    expect(prisma.passwordResetToken.update).toHaveBeenCalledWith({
      where: { id: 'token-1' },
      data: { usedAt: expect.any(Date) },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ message: 'Senha redefinida com sucesso' });
  });

  it.each([
    ['inexistente', null],
    [
      'expirado',
      {
        id: 'token-1',
        userId: 'user-1',
        expiresAt: new Date(Date.now() - 1_000),
        usedAt: null,
      },
    ],
    [
      'já usado',
      {
        id: 'token-1',
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: new Date(),
      },
    ],
  ])('recusa a redefinição com token %s', async (_caso, stored) => {
    const { service, prisma } = buildService({
      passwordResetToken: {
        deleteMany: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(stored),
        update: jest.fn(),
      },
    });

    await expect(
      service.resetPassword({ token: 'b'.repeat(64), newPassword: 'novaSenha123' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.passwordResetToken.update).not.toHaveBeenCalled();
  });
});
