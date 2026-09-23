import { AccountType, ProfileType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

// O serviço não valida dígito verificador (quem valida é o DTO): um CPF de
// formato correto basta, e nunca um CPF real como literal.
const CPF = '123.456.789-00';
// Senha de teste gerada, para não haver credencial literal no código.
const TEST_PASSWORD = 'p'.repeat(12);

const ADDRESS = {
  postalCode: '80240-000',
  street: 'Rua das Flores',
  addressNumber: '123',
  neighborhood: 'Centro',
  city: 'Curitiba',
  state: 'PR',
};

function createMocks() {
  const tx = {
    user: { create: jest.fn() },
    individualProfile: { create: jest.fn().mockResolvedValue({ id: 'profile-1' }) },
    businessProfile: { create: jest.fn().mockResolvedValue({ id: 'profile-2' }) },
    account: { create: jest.fn().mockResolvedValue({ id: 'account-1' }) },
    whatsappContact: { upsert: jest.fn() },
  };
  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn() },
    individualProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    businessProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const sessions = {
    createSession: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
  };
  const whatsappLink = { hasLinkedPhone: jest.fn().mockResolvedValue(false) };
  const service = new AuthService(prisma as any, sessions as any, whatsappLink as any);
  return { tx, prisma, sessions, whatsappLink, service };
}

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    name: 'Joao Grilo',
    email: 'joao@example.com',
    passwordHash: 'hashed',
    profileType: ProfileType.individual,
    phone: '(19) 99999-9999',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('AuthService', () => {
  describe('register', () => {
    it('cria perfil PF e conta padrão, sem vincular o WhatsApp', async () => {
      const { tx, prisma, service } = createMocks();
      tx.user.create.mockResolvedValue(userRow());

      const result = await service.register({
        name: 'Joao Grilo',
        email: '  Joao@Example.com ',
        phone: '(19) 99999-9999',
        password: TEST_PASSWORD,
        profileType: ProfileType.individual,
        cpf: CPF,
        ...ADDRESS,
      });

      // E-mail normalizado na busca e na gravação.
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: { equals: 'joao@example.com', mode: 'insensitive' } },
      });
      expect(tx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'joao@example.com',
          phone: '(19) 99999-9999',
          profileType: ProfileType.individual,
        }),
      });
      expect(tx.individualProfile.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'user-1', cpf: CPF }),
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
      // O número só vira vínculo depois do desafio de posse (S1.1).
      expect(tx.whatsappContact.upsert).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('cria perfil PJ e conta padrão', async () => {
      const { tx, service } = createMocks();
      tx.user.create.mockResolvedValue(
        userRow({ id: 'user-2', profileType: ProfileType.business }),
      );

      await service.register({
        name: 'Padaria do Joao',
        email: 'contato@padaria.com',
        phone: '(19) 98888-7777',
        password: TEST_PASSWORD,
        profileType: ProfileType.business,
        companyName: 'Padaria do Joao LTDA',
        tradeName: 'Padaria do Joao',
        cnpj: '12.345.678/0001-99',
        ...ADDRESS,
      });

      expect(tx.businessProfile.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-2',
          companyName: 'Padaria do Joao LTDA',
          cnpj: '12.345.678/0001-99',
        }),
      });
      expect(tx.individualProfile.create).not.toHaveBeenCalled();
      expect(tx.whatsappContact.upsert).not.toHaveBeenCalled();
    });

    it('recusa e-mail já cadastrado mesmo com outra caixa', async () => {
      const { prisma, service } = createMocks();
      prisma.user.findFirst.mockResolvedValue(userRow());

      await expect(
        service.register({
          name: 'Outro',
          email: 'JOAO@EXAMPLE.COM',
          phone: '(19) 99999-9999',
          password: TEST_PASSWORD,
          profileType: ProfileType.individual,
          cpf: CPF,
          ...ADDRESS,
        }),
      ).rejects.toThrow('Email já cadastrado');
    });
  });

  describe('login', () => {
    it('cria uma sessão com os metadados da requisição', async () => {
      const { prisma, sessions, service } = createMocks();
      prisma.user.findFirst.mockResolvedValue(
        userRow({ passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) }),
      );

      const result = await service.login(
        { email: 'JOAO@example.com', password: TEST_PASSWORD },
        { userAgent: 'jest', ip: '127.0.0.1' },
      );

      expect(sessions.createSession).toHaveBeenCalledWith('user-1', {
        userAgent: 'jest',
        ip: '127.0.0.1',
      });
      expect(result.tokens).toEqual({ accessToken: 'a', refreshToken: 'r' });
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.user.whatsappVerified).toBe(false);
    });

    it('recusa senha errada sem criar sessão', async () => {
      const { prisma, sessions, service } = createMocks();
      prisma.user.findFirst.mockResolvedValue(
        userRow({ passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) }),
      );

      await expect(
        service.login({ email: 'joao@example.com', password: 'x'.repeat(12) }),
      ).rejects.toThrow('Credenciais inválidas');
      expect(sessions.createSession).not.toHaveBeenCalled();
    });
  });

  describe('me', () => {
    it('informa se o WhatsApp está verificado', async () => {
      const { prisma, whatsappLink, service } = createMocks();
      prisma.user.findUnique.mockResolvedValue({
        ...userRow(),
        individualProfile: { id: 'p' },
        businessProfile: null,
      });
      whatsappLink.hasLinkedPhone.mockResolvedValue(true);

      const me = await service.me('user-1');

      expect(me).toEqual(
        expect.objectContaining({ id: 'user-1', hasProfile: true, whatsappVerified: true }),
      );
      expect(me).not.toHaveProperty('passwordHash');
    });
  });
});
