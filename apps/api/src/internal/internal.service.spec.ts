import { Prisma } from '@prisma/client';

import { InternalService } from './internal.service';

/** Cria um mock mínimo do PrismaService com as entidades usadas pelo serviço. */
function createPrismaMock() {
  return {
    whatsappContact: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    aiConversation: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    aiMessage: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    account: { findMany: jest.fn(), findUnique: jest.fn() },
    category: { findMany: jest.fn(), findUnique: jest.fn() },
    transaction: { create: jest.fn() },
    aiExtractedTransaction: { update: jest.fn() },
  };
}

describe('InternalService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: InternalService;

  let access: { canUseProduct: jest.Mock; isEnforced: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaMock();
    access = {
      canUseProduct: jest.fn().mockResolvedValue({ allowed: true }),
      isEnforced: jest.fn().mockReturnValue(true),
    };
    service = new InternalService(prisma as any, {} as any, access as any);
  });

  describe('listRecentMessagesByPhone', () => {
    it('normaliza o telefone ao buscar o contato', async () => {
      prisma.whatsappContact.findUnique.mockResolvedValue(null);

      await service.listRecentMessagesByPhone('11999999999');

      expect(prisma.whatsappContact.findUnique).toHaveBeenCalledWith({
        where: { phoneNumber: '+5511999999999' },
      });
    });

    it('retorna vazio quando não há contato', async () => {
      prisma.whatsappContact.findUnique.mockResolvedValue(null);

      const result = await service.listRecentMessagesByPhone('+5511999999999');

      expect(result).toEqual({ conversationId: null, messages: [] });
    });

    it('retorna vazio quando não há conversa ativa', async () => {
      prisma.whatsappContact.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.aiConversation.findFirst.mockResolvedValue(null);

      const result = await service.listRecentMessagesByPhone('+5511999999999');

      expect(result).toEqual({ conversationId: null, messages: [] });
    });

    it('limita o take a no máximo 50 e devolve em ordem cronológica', async () => {
      prisma.whatsappContact.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.aiConversation.findFirst.mockResolvedValue({ id: 'conv1' });
      // findMany devolve desc; o serviço inverte para cronológico.
      prisma.aiMessage.findMany.mockResolvedValue([
        { id: 'm2', content: 'b' },
        { id: 'm1', content: 'a' },
      ]);

      const result = await service.listRecentMessagesByPhone('+5511999999999', 100);

      expect(prisma.aiMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50, where: { conversationId: 'conv1' } }),
      );
      expect(result.conversationId).toBe('conv1');
      expect(result.messages.map((m: any) => m.id)).toEqual(['m1', 'm2']);
    });
  });

  describe('controle de assinatura', () => {
    it('listAccounts bloqueia usuário sem assinatura', async () => {
      access.canUseProduct.mockResolvedValue({ allowed: false });

      await expect(service.listAccounts('u1')).rejects.toMatchObject({
        getResponse: expect.any(Function),
      });
      expect(prisma.account.findMany).not.toHaveBeenCalled();
    });

    it('listAccounts libera usuário com assinatura', async () => {
      access.canUseProduct.mockResolvedValue({ allowed: true });
      prisma.account.findMany.mockResolvedValue([{ id: 'a1' }]);

      const result = await service.listAccounts('u1');

      expect(access.canUseProduct).toHaveBeenCalledWith('u1');
      expect(result).toEqual([{ id: 'a1' }]);
    });

    it('createTransactionFromAi bloqueia antes de tocar no banco quando sem assinatura', async () => {
      access.canUseProduct.mockResolvedValue({ allowed: false });

      await expect(
        service.createTransactionFromAi({ userId: 'u1', accountId: 'a1' } as any),
      ).rejects.toMatchObject({ getResponse: expect.any(Function) });
      expect(prisma.account.findUnique).not.toHaveBeenCalled();
    });

    it('libera listAccounts quando a obrigatoriedade está desligada (rollout)', async () => {
      access.isEnforced.mockReturnValue(false);
      access.canUseProduct.mockResolvedValue({ allowed: false });
      prisma.account.findMany.mockResolvedValue([{ id: 'a1' }]);

      const result = await service.listAccounts('u1');

      expect(result).toEqual([{ id: 'a1' }]);
      expect(access.canUseProduct).not.toHaveBeenCalled();
    });

    it('createTransactionFromAi rejeita conta de outro usuário (userId manipulado)', async () => {
      access.canUseProduct.mockResolvedValue({ allowed: true });
      prisma.account.findUnique.mockResolvedValue({ id: 'a1', userId: 'outro' });

      await expect(
        service.createTransactionFromAi({ userId: 'u1', accountId: 'a1' } as any),
      ).rejects.toThrow('Conta inválida para o usuário');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });
  });

  describe('recordEvent (message)', () => {
    it('cria conversa quando não existe e grava a mensagem', async () => {
      prisma.whatsappContact.upsert.mockResolvedValue({ id: 'contact1', userId: 'u1' });
      prisma.aiConversation.findFirst.mockResolvedValue(null);
      prisma.aiConversation.create.mockResolvedValue({ id: 'conv1' });
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg1', conversationId: 'conv1' });

      const result = await service.recordEvent({
        eventType: 'message',
        phone: '+5511999999999',
        direction: 'inbound' as any,
        content: 'gastei 50',
      } as any);

      expect(prisma.aiConversation.create).toHaveBeenCalled();
      expect(result).toEqual({ id: 'msg1', conversationId: 'conv1' });
    });

    it('reusa a conversa ativa existente', async () => {
      prisma.whatsappContact.upsert.mockResolvedValue({ id: 'contact1', userId: 'u1' });
      prisma.aiConversation.findFirst.mockResolvedValue({ id: 'convX' });
      prisma.aiConversation.update.mockResolvedValue({ id: 'convX' });
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg2', conversationId: 'convX' });

      const result = await service.recordEvent({
        eventType: 'message',
        phone: '+5511999999999',
        direction: 'inbound' as any,
        content: 'oi',
      } as any);

      expect(prisma.aiConversation.create).not.toHaveBeenCalled();
      expect(prisma.aiConversation.update).toHaveBeenCalled();
      expect(result).toEqual({ id: 'msg2', conversationId: 'convX' });
    });

    it('é idempotente por providerMessageId (não duplica)', async () => {
      prisma.aiMessage.findUnique.mockResolvedValue({ id: 'existing', conversationId: 'conv1' });

      const result = await service.recordEvent({
        eventType: 'message',
        phone: '+5511999999999',
        direction: 'inbound' as any,
        content: 'gastei 50',
        metadata: { messageId: 'm1' },
      } as any);

      expect(prisma.aiMessage.findUnique).toHaveBeenCalledWith({
        where: { providerMessageId: 'm1' },
      });
      expect(prisma.aiMessage.create).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'existing', conversationId: 'conv1', duplicate: true });
    });

    it('grava providerMessageId/providerTimestamp ao criar', async () => {
      prisma.aiMessage.findUnique.mockResolvedValue(null);
      prisma.whatsappContact.upsert.mockResolvedValue({ id: 'contact1', userId: 'u1' });
      prisma.aiConversation.findFirst.mockResolvedValue({ id: 'conv1' });
      prisma.aiConversation.update.mockResolvedValue({ id: 'conv1' });
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg1', conversationId: 'conv1' });

      await service.recordEvent({
        eventType: 'message',
        phone: '+5511999999999',
        direction: 'inbound' as any,
        content: 'gastei 50',
        metadata: { messageId: 'm1', timestamp: 1700000000 },
      } as any);

      const createArg = prisma.aiMessage.create.mock.calls[0][0];
      expect(createArg.data.providerMessageId).toBe('m1');
      expect(createArg.data.providerTimestamp).toEqual(new Date(1700000000 * 1000));
    });

    it('trata corrida no unique (P2002) devolvendo a mensagem existente', async () => {
      prisma.aiMessage.findUnique
        .mockResolvedValueOnce(null) // checagem inicial
        .mockResolvedValueOnce({ id: 'existing', conversationId: 'conv1' }); // após P2002
      prisma.whatsappContact.upsert.mockResolvedValue({ id: 'contact1', userId: 'u1' });
      prisma.aiConversation.findFirst.mockResolvedValue({ id: 'conv1' });
      prisma.aiConversation.update.mockResolvedValue({ id: 'conv1' });
      prisma.aiMessage.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const result = await service.recordEvent({
        eventType: 'message',
        phone: '+5511999999999',
        direction: 'inbound' as any,
        content: 'gastei 50',
        metadata: { messageId: 'm1' },
      } as any);

      expect(result).toEqual({ id: 'existing', conversationId: 'conv1', duplicate: true });
    });
  });
});
