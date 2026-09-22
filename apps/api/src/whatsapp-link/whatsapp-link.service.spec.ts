import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { sha256Hex } from '../common/crypto.util';
import { phoneVariants } from '../common/phone.util';
import { MAX_VERIFICATION_ATTEMPTS, WhatsappLinkService } from './whatsapp-link.service';

const TEST_PASSWORD = 'p'.repeat(12);

function createPrismaMock() {
  const mock: any = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    whatsappContact: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    phoneVerification: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      deleteMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    aiConversation: { updateMany: jest.fn() },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'contact-1' }]),
  };
  mock.$transaction = jest.fn(async (arg: any) =>
    typeof arg === 'function' ? arg(mock) : Promise.all(arg),
  );
  return mock;
}

function createService(botNumber = '5511900000000') {
  const prisma = createPrismaMock();
  const config = { get: (key: string) => (key === 'WHATSAPP_BOT_NUMBER' ? botNumber : undefined) };
  const securityEvents = { record: jest.fn().mockResolvedValue(undefined) };
  return {
    prisma,
    securityEvents,
    service: new WhatsappLinkService(prisma, securityEvents as any, config as any),
  };
}

function verification(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as string) ?? 'ver-1';
  const code = (overrides.code as string) ?? '123456';
  return {
    id,
    userId: 'user-1',
    phoneNumber: '+5519999999999',
    displayPhone: '(19) 99999-9999',
    codeHash: sha256Hex(`${id}:${code}`),
    attempts: 0,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('phoneVariants', () => {
  it('relaciona celular com e sem o nono dígito', () => {
    expect(phoneVariants('+5519999999999')).toEqual(['+5519999999999', '+551999999999']);
    expect(phoneVariants('+551999999999')).toEqual(['+551999999999', '+5519999999999']);
  });

  it('não inventa variante para fixo nem número estrangeiro', () => {
    expect(phoneVariants('+551933334444')).toEqual(['+551933334444']);
    expect(phoneVariants('+14155550100')).toEqual(['+14155550100']);
  });
});

describe('WhatsappLinkService', () => {
  describe('startVerification', () => {
    it('gera código e link wa.me com a mensagem preenchida', async () => {
      const { prisma, service } = createService();
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', phone: '(19) 99999-9999' });

      const challenge = await service.startVerification('user-1', {});

      expect(challenge.code).toMatch(/^\d{6}$/);
      expect(challenge.phone).toBe('(19) 99999-9999');
      expect(challenge.message).toContain(challenge.code);
      expect(challenge.waLink).toBe(
        `https://wa.me/5511900000000?text=${encodeURIComponent(challenge.message)}`,
      );
      // Desafios anteriores do usuário são descartados; só o hash é gravado.
      expect(prisma.phoneVerification.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', consumedAt: null },
      });
      const created = prisma.phoneVerification.create.mock.calls[0][0].data;
      expect(created.phoneNumber).toBe('+5519999999999');
      expect(created.codeHash).not.toContain(challenge.code);
    });

    it('sem número do bot configurado, devolve o código sem link', async () => {
      const { prisma, service } = createService('');
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', phone: '(19) 99999-9999' });

      const challenge = await service.startVerification('user-1', {});
      expect(challenge.waLink).toBeNull();
    });

    it('trocar um número já verificado exige a senha atual', async () => {
      const { prisma, service } = createService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        phone: '(19) 99999-9999',
        passwordHash: await bcrypt.hash(TEST_PASSWORD, 4),
      });
      prisma.whatsappContact.findFirst.mockResolvedValue({ phoneNumber: '+5519999999999' });

      await expect(
        service.startVerification('user-1', { phone: '(19) 98888-7777' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      await expect(
        service.startVerification('user-1', {
          phone: '(19) 98888-7777',
          currentPassword: TEST_PASSWORD,
        }),
      ).resolves.toEqual(expect.objectContaining({ status: 'pending' }));
    });

    it('reverificar o mesmo número não pede senha', async () => {
      const { prisma, service } = createService();
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', phone: '(19) 99999-9999' });
      // Vínculo antigo salvo sem o nono dígito continua sendo "o mesmo número".
      prisma.whatsappContact.findFirst.mockResolvedValue({ phoneNumber: '+551999999999' });

      await expect(service.startVerification('user-1', {})).resolves.toEqual(
        expect.objectContaining({ status: 'pending' }),
      );
    });
  });

  describe('confirmFromWhatsapp', () => {
    it('sem desafio para o número responde not_found', async () => {
      const { service } = createService();
      await expect(service.confirmFromWhatsapp('+5519999999999', '123456')).resolves.toEqual({
        status: 'not_found',
      });
    });

    it('busca o desafio pelas duas formas do número', async () => {
      const { prisma, service } = createService();
      await service.confirmFromWhatsapp('551999999999', '123456');

      expect(prisma.phoneVerification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            phoneNumber: { in: ['+551999999999', '+5519999999999'] },
            consumedAt: null,
          },
        }),
      );
    });

    it('código errado conta tentativa e não vincula', async () => {
      const { prisma, service } = createService();
      prisma.phoneVerification.findMany.mockResolvedValue([verification()]);

      const result = await service.confirmFromWhatsapp('+5519999999999', '000000');

      expect(result).toEqual({ status: 'invalid_code' });
      expect(prisma.phoneVerification.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['ver-1'] } },
        data: { attempts: { increment: 1 } },
      });
      expect(prisma.whatsappContact.update).not.toHaveBeenCalled();
    });

    it('desafio expirado ou esgotado responde expired', async () => {
      const { prisma, service } = createService();
      prisma.phoneVerification.findMany.mockResolvedValue([
        verification({ attempts: MAX_VERIFICATION_ATTEMPTS }),
        verification({ id: 'ver-2', expiresAt: new Date(Date.now() - 1000) }),
      ]);

      await expect(service.confirmFromWhatsapp('+5519999999999', '123456')).resolves.toEqual({
        status: 'expired',
      });
    });

    it('código certo vincula o número de origem e revoga os anteriores', async () => {
      const { prisma, securityEvents, service } = createService();
      // O usuário digitou com nono dígito; a Meta entregou sem.
      prisma.phoneVerification.findMany.mockResolvedValue([verification()]);
      prisma.whatsappContact.findUniqueOrThrow.mockResolvedValue({
        id: 'contact-1',
        userId: null,
        isVerified: false,
        revokedAt: null,
      });
      prisma.whatsappContact.findMany.mockResolvedValue([{ id: 'old-contact' }]);
      prisma.user.update.mockResolvedValue({
        id: 'user-1',
        name: 'Joao',
        profileType: 'individual',
      });

      const result = await service.confirmFromWhatsapp('+551999999999', '123456');

      expect(result).toEqual({
        status: 'verified',
        userId: 'user-1',
        name: 'Joao',
        profileType: 'individual',
      });
      // Consome o desafio de forma condicional (só um vencedor).
      expect(prisma.phoneVerification.updateMany).toHaveBeenCalledWith({
        where: { id: 'ver-1', consumedAt: null, expiresAt: { gt: expect.any(Date) } },
        data: { consumedAt: expect.any(Date) },
      });
      // O contato vinculado é o do número que enviou a mensagem.
      expect(prisma.$queryRaw.mock.calls[0]).toContain('+551999999999');
      expect(prisma.whatsappContact.update).toHaveBeenCalledWith({
        where: { id: 'contact-1' },
        data: expect.objectContaining({
          userId: 'user-1',
          isVerified: true,
          revokedAt: null,
          linkVersion: { increment: 1 },
        }),
      });
      // O número anterior é revogado e suas conversas encerradas.
      expect(prisma.whatsappContact.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['old-contact'] } },
        data: { isVerified: false, revokedAt: expect.any(Date), linkVersion: { increment: 1 } },
      });
      expect(prisma.aiConversation.updateMany).toHaveBeenCalledWith({
        where: { whatsappContactId: { in: ['old-contact'] }, status: 'active' },
        data: { status: 'abandoned' },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { phone: '(19) 99999-9999' },
      });
      // A verificação entra na trilha da conta (S4).
      expect(securityEvents.record).toHaveBeenCalledWith(
        'user-1',
        'phone_verified',
        expect.objectContaining({
          metadata: { origem: 'whatsapp', telefone: '(19) 99999-9999' },
        }),
      );
    });

    it('perder a corrida de consumo não vincula nada', async () => {
      const { prisma, service } = createService();
      prisma.phoneVerification.findMany.mockResolvedValue([verification()]);
      prisma.phoneVerification.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.confirmFromWhatsapp('+5519999999999', '123456')).resolves.toEqual({
        status: 'expired',
      });
      expect(prisma.whatsappContact.update).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('número verificado por outra conta passa para quem provou a posse', async () => {
      const { prisma, service } = createService();
      prisma.phoneVerification.findMany.mockResolvedValue([verification()]);
      prisma.whatsappContact.findUniqueOrThrow.mockResolvedValue({
        id: 'contact-1',
        userId: 'user-antigo',
        isVerified: true,
        revokedAt: null,
      });
      prisma.user.update.mockResolvedValue({
        id: 'user-1',
        name: 'Joao',
        profileType: 'individual',
      });

      await service.confirmFromWhatsapp('+5519999999999', '123456');

      expect(prisma.whatsappContact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'user-1', linkVersion: { increment: 1 } }),
        }),
      );
      expect(prisma.aiConversation.updateMany).toHaveBeenCalledWith({
        where: { whatsappContactId: { in: ['contact-1'] }, status: 'active' },
        data: { status: 'abandoned' },
      });
    });
  });

  describe('getState', () => {
    it('informa verified depois do consumo', async () => {
      const { prisma, service } = createService();
      prisma.phoneVerification.findFirst.mockResolvedValue(
        verification({ consumedAt: new Date() }),
      );
      prisma.whatsappContact.findFirst.mockResolvedValue({ phoneNumber: '+5519999999999' });
      prisma.user.findUnique.mockResolvedValue({ phone: '(19) 99999-9999' });

      await expect(service.getState('user-1')).resolves.toEqual(
        expect.objectContaining({ status: 'verified', linkedPhone: '(19) 99999-9999' }),
      );
    });
  });
});
