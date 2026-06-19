import { AccountType, ProfileType } from '@prisma/client';
import { AuthService } from './auth.service';

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
    };
    const prisma = {
      user: {
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

    const service = new AuthService(prisma as any, {} as any, {} as any);

    const result = await service.register({
      name: 'Joao Grilo',
      email: 'joao@example.com',
      password: 'password123',
      profileType: ProfileType.individual,
      cpf: '123.456.789-09',
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
    };
    const prisma = {
      user: {
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

    const service = new AuthService(prisma as any, {} as any, {} as any);

    const result = await service.register({
      name: 'Padaria do Joao',
      email: 'contato@padaria.com',
      password: 'password123',
      profileType: ProfileType.business,
      companyName: 'Padaria do Joao LTDA',
      tradeName: 'Padaria do Joao',
      cnpj: '12.345.678/0001-99',
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
    expect(result).not.toHaveProperty('passwordHash');
  });
});
